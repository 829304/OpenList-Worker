import { AsyncQueue, concat, decode } from "./bytes.js"
import {
  frame,
  openAnyTlsNode,
  parsePadding,
  streamAddress,
  streamSettings,
} from "./protocol.js"
import { API_CONNECTION_IDLE_MS, API_CONNECTION_MAX_AGE_MS } from "./pool.js"

/** Reuse the airport session independently of each upstream HTTPS connection. */
export class AnyTlsSessionPool {
  constructor({ connect, Scope, openNode = openAnyTlsNode }) {
    Object.assign(this, { connect, Scope, openNode })
    this.entries = new Map()
    this.sessions = new Set()
    this.padding = new Map()
  }
  async close() {
    await Promise.all([...this.sessions].map((session) => session.close()))
    this.entries.clear()
  }
  async open(connect, env, target, scope) {
    const key = JSON.stringify([
      env.ANYTLS_SERVER,
      env.ANYTLS_PORT,
      env.ANYTLS_PASSWORD,
      env.ANYTLS_SNI,
      env.ANYTLS_ALPN,
      env.ANYTLS_INSECURE,
    ])
    let entry = this.entries.get(key)
    let reused = true
    if (entry) {
      const existing = await entry
      if (
        existing.closed() ||
        Date.now() - existing.created >= API_CONNECTION_MAX_AGE_MS
      ) {
        if (!existing.streams.size) await existing.close()
        this.entries.delete(key)
        entry = undefined
      }
    }
    if (!entry) {
      reused = false
      if (this.entries.size >= 4 || this.sessions.size >= 4)
        throw new Error("node_pool_capacity")
      entry = this.create(env, scope, key)
      this.entries.set(key, entry)
      try {
        await entry
      } catch (error) {
        if (this.entries.get(key) === entry) this.entries.delete(key)
        throw error
      }
    }
    const session = await entry
    session.entry = entry
    if (scope.signal.aborted) throw new Error("request_cancelled")
    scope.nodeReused = reused
    scope.currentStage = undefined
    scope.timings = []
    if (!reused) scope.timings.push(...session.setupTimings)
    return session.open(target, scope)
  }
  async create(env, caller, key) {
    const lifetime = new this.Scope(caller.signal)
    const padding = this.padding.get(key)
    let transport
    try {
      transport = await this.openNode(this.connect, env, lifetime, { padding })
    } catch (error) {
      await lifetime.close()
      throw error
    }
    lifetime.suspendDeadline = true
    lifetime.stage = "node_ready"
    lifetime.finish() // Detach the first caller; later stream cancellation is independent.
    const session = {
      created: Date.now(),
      streams: new Map(),
      setupTimings: [...lifetime.timings],
      closed: () => lifetime.signal.aborted,
      close: async () => {
        for (const stream of session.streams.values()) {
          stream.queue.finish(new Error("node_peer_closed"))
          stream.scope.signal.removeEventListener("abort", stream.onAbort)
        }
        session.streams.clear()
        await lifetime.close()
        this.sessions.delete(session)
        if (this.entries.get(key) === session.entry) this.entries.delete(key)
      },
    }
    session.entry = this.entries.get(key)
    this.sessions.add(session)
    let nextId = 1,
      first = true
    const idle = () => {
      if (session.closed() || session.streams.size) return
      const remaining =
        API_CONNECTION_MAX_AGE_MS - (Date.now() - session.created)
      if (remaining <= 0) void session.close()
      else {
        lifetime.suspendDeadline = false
        lifetime.idle(Math.min(API_CONNECTION_IDLE_MS, remaining))
      }
    }
    lifetime.signal.addEventListener(
      "abort",
      () => {
        void session.close()
      },
      { once: true },
    )
    const end = async (id, error, notify = false) => {
      const stream = session.streams.get(id)
      if (!stream) return
      session.streams.delete(id)
      stream.scope.signal.removeEventListener("abort", stream.onAbort)
      stream.queue.finish(error)
      if (notify && !session.closed()) {
        try {
          await transport.send(frame(3, id))
        } catch {
          await session.close()
        }
      }
      idle()
    }
    session.open = async (target, scope) => {
      if (session.closed()) throw new Error("node_peer_closed")
      if (session.streams.size >= 4) throw new Error("node_stream_capacity")
      lifetime.suspendDeadline = true
      lifetime.finish()
      const id = nextId++
      const queue = new AsyncQueue()
      const onAbort = () => {
        void end(id, new Error("request_cancelled"), true)
      }
      session.streams.set(id, { queue, scope, onAbort, connected: false })
      scope.signal.addEventListener("abort", onAbort, { once: true })
      if (scope.signal.aborted) {
        await end(id, new Error("request_cancelled"))
        throw new Error("request_cancelled")
      }
      scope.socket = {
        close: () => end(id, new Error("request_cancelled"), true),
      }
      scope.stage = "target_connect"
      const settings = first ? streamSettings(padding) : new Uint8Array()
      first = false
      try {
        await transport.send(
          concat(settings, frame(1, id), frame(2, id, streamAddress(target))),
        )
      } catch (error) {
        await session.close()
        throw error
      }
      return {
        detailedTimings: true,
        read: () => queue.read(),
        write: async (data) => {
          if (queue.done || session.closed())
            throw new Error("target_peer_closed")
          for (let offset = 0; offset < data.length; offset += 16000)
            await transport.send(
              frame(2, id, data.slice(offset, offset + 16000)),
            )
        },
        close: () => end(id, undefined, true),
      }
    }
    const pump = async () => {
      try {
        while (!session.closed()) {
          const head = await transport.incoming.exact(7)
          if (!head) break
          const view = new DataView(
            head.buffer,
            head.byteOffset,
            head.byteLength,
          )
          const command = head[0],
            id = view.getUint32(1),
            size = view.getUint16(5)
          const payload = size
            ? await transport.incoming.exact(size)
            : new Uint8Array()
          if (!payload) throw new Error("truncated_anytls")
          if (command === 5) throw new Error("node_rejected_session")
          if (command === 6) {
            this.padding.set(key, parsePadding(decode(payload)))
            if (this.padding.size > 4)
              this.padding.delete(this.padding.keys().next().value)
          }
          if (command === 8) await transport.send(frame(9, id))
          const stream = session.streams.get(id)
          if (!stream) continue
          if (command === 7 && size) {
            await end(id, new Error("target_connection_rejected"))
          } else if (command === 7 || (command === 2 && size)) {
            if (!stream.connected) {
              stream.connected = true
              stream.scope.stage = "target_tls"
            }
            if (command === 2) {
              await stream.queue.capacity()
              stream.queue.push(payload)
            }
          } else if (command === 3) await end(id)
        }
      } catch {
        // Propagate a generic failure, never the server's alert text or node credentials.
      } finally {
        await session.close()
      }
    }
    void pump()
    idle()
    return session
  }
}
