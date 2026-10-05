import { concat } from "./bytes.js"
import { readHttpResponse } from "./http.js"

export const API_CONNECTION_IDLE_MS = 120000
export const API_CONNECTION_MAX_AGE_MS = 300000

/** Only small 115 API responses use persistent connections, never file streams. */
export class ApiConnectionPool {
  constructor({ connect, openTunnel, secure, Scope }) {
    Object.assign(this, { connect, openTunnel, secure, Scope })
    this.entries = new Map()
  }
  async close() {
    for (const entry of this.entries.values())
      await entry.connection?.scope.close()
    this.entries.clear()
  }
  async fetch(request, input, env) {
    const queuedAt = Date.now()
    const key = JSON.stringify([
      env.ANYTLS_SERVER,
      env.ANYTLS_PORT,
      env.ANYTLS_PASSWORD,
      env.ANYTLS_SNI,
      env.ANYTLS_ALPN,
      env.ANYTLS_INSECURE,
      input.target.hostname,
    ])
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= 4) {
        const oldest = this.entries.keys().next().value
        const previous = this.entries.get(oldest)
        // Do not evict an active connection; bounded queueing prevents an
        // authenticated caller from accumulating unlimited pending work.
        if (previous.pending) throw new Error("api_pool_capacity")
        await previous.connection?.scope.close()
        this.entries.delete(oldest)
      }
      entry = { tail: Promise.resolve(), pending: 0 }
      this.entries.set(key, entry)
    }
    if (entry.pending >= 16) throw new Error("api_pool_busy")
    entry.pending++
    let release
    const slot = new Promise((resolve) => {
      release = resolve
    })
    const previous = entry.tail
    entry.tail = previous.then(() => slot)
    try {
      await previous
      if (request.signal.aborted) throw new Error("request_cancelled")
      const queueMs = Date.now() - queuedAt
      const response = await this.execute(entry, request, input, env)
      response.headers.append("Server-Timing", `queue;dur=${queueMs}`)
      return response
    } finally {
      entry.pending--
      release()
    }
  }
  async execute(entry, request, input, env, retried = false) {
    let connection = entry.connection
    if (
      connection &&
      (connection.scope.signal.aborted ||
        connection.target.closed?.() ||
        Date.now() - connection.created >= API_CONNECTION_MAX_AGE_MS)
    ) {
      await connection.scope.close()
      entry.connection = connection = undefined
    }
    const reused = Boolean(connection)
    const scope = new this.Scope(request.signal)
    const setupTimings = []
    try {
      if (!connection) {
        // The connection lifetime belongs to this DO, independent of an
        // individual HTTP caller. Request cancellation still closes it below.
        const lifetime = new this.Scope(new AbortController().signal)
        scope.socket = { close: () => lifetime.close() }
        const tunnel = await this.openTunnel(
          this.connect,
          env,
          input.target,
          lifetime,
        )
        if (!tunnel.detailedTimings) lifetime.stage = "target_tls"
        const target = await this.secure(
          input.target.hostname,
          tunnel,
          lifetime,
        )
        if (
          target.metadata.selectedAlpn &&
          target.metadata.selectedAlpn !== "http/1.1"
        )
          throw new Error("unexpected_alpn")
        lifetime.stage = "ready"
        setupTimings.push(...lifetime.timings)
        connection = { scope: lifetime, target, created: Date.now() }
        entry.connection = connection
      }
      connection.scope.finish()
      connection.scope.idleMs = 30000
      connection.scope.stage = "active"
      scope.socket = { close: () => connection.scope.close() }
      scope.complete = async () => scope.finish()
      // Connection setup has its own component timings above.
      scope.currentStage = undefined
      scope.timings = []
      scope.stage = "request_write"
      await connection.target.write(input.bytes)
      scope.stage = "response_headers"
      const response = await readHttpResponse(
        connection.target,
        input.method,
        scope,
      )
      const chunks = []
      let size = 0
      const reader = response.body?.getReader()
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.length
            if (size > 2 * 1024 * 1024) throw new Error("api_response_limit")
            chunks.push(value)
          }
        } catch (error) {
          await reader.cancel().catch(() => {})
          throw error
        }
      }
      scope.finish()
      const remainingLifetime =
        API_CONNECTION_MAX_AGE_MS - (Date.now() - connection.created)
      if (
        !connection.scope.signal.aborted &&
        !connection.target.closed?.() &&
        remainingLifetime > 0
      ) {
        connection.scope.idle(
          Math.min(API_CONNECTION_IDLE_MS, remainingLifetime),
        )
      } else {
        await connection.scope.close()
        entry.connection = undefined
      }
      response.headers.set("X-OpenList-Gateway-Upstream", "1")
      response.headers.set(
        "X-OpenList-Gateway-Connection",
        reused ? "reused" : "new",
      )
      if (connection.scope.nodeReused !== undefined)
        response.headers.set(
          "X-OpenList-Gateway-Node-Connection",
          reused || connection.scope.nodeReused ? "reused" : "new",
        )
      response.headers.set(
        "X-OpenList-Gateway-TLS",
        connection.target.metadata.version || "unknown",
      )
      response.headers.set(
        "Server-Timing",
        [...setupTimings, ...scope.timings]
          .map(([name, ms]) => `${name};dur=${ms}`)
          .join(", "),
      )
      return new Response(response.body ? concat(...chunks) : null, {
        status: response.status,
        headers: response.headers,
      })
    } catch (error) {
      await scope.close()
      entry.connection = undefined
      // Only read-only requests can safely retry a connection closed while idle.
      if (
        reused &&
        !retried &&
        input.method === "GET" &&
        !request.signal.aborted
      )
        return this.execute(entry, request, input, env, true)
      throw error
    } finally {
      scope.finish()
    }
  }
}
