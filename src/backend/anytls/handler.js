import { createHash, timingSafeEqual } from "node:crypto"
import { MAX_REQUEST_BYTES, readHttpResponse, validateRequest } from "./http.js"
import { openAnyTls } from "./protocol.js"
import { wrapTls } from "./tls.js"
import { ApiConnectionPool, API_CONNECTION_IDLE_MS } from "./pool.js"
import { AnyTlsSessionPool } from "./session.js"

const DEFAULT_HOSTS = "proapi.115.com,passportapi.115.com,*.115cdn.net"
export function authorized(request, secret) {
  if (!secret || secret.length < 16) return false
  const supplied = request.headers.get("authorization") || ""
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(`Bearer ${secret}`).digest(),
  )
}
export class RequestScope {
  constructor(signal) {
    this.timings = []
    this.stageStarted = Date.now()
    this.controller = new AbortController()
    this.signal = this.controller.signal
    this.stage = "request"
    this.idleMs = 30000
    this.parentSignal = signal
    this.onAbort = () => {
      this.close()
    }
    signal.addEventListener("abort", this.onAbort, { once: true })
    if (signal.aborted) this.close()
    else this.touch()
  }
  set stage(value) {
    const now = Date.now()
    if (this.currentStage)
      this.timings.push([
        this.currentStage,
        Math.max(0, now - this.stageStarted),
      ])
    this.currentStage = value
    this.stageStarted = now
  }
  get stage() {
    return this.currentStage
  }
  touch() {
    if (this.suspendDeadline) return
    if (this.stage !== "response_body" && this.timer) return
    clearTimeout(this.timer)
    if (!this.signal.aborted)
      this.timer = setTimeout(() => {
        this.timedOut = true
        this.close()
      }, this.idleMs)
  }
  streaming() {
    this.stage = "response_body"
    this.idleMs = 60000
    this.touch()
  }
  finish() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.parentSignal.removeEventListener("abort", this.onAbort)
  }
  idle(idleMs = API_CONNECTION_IDLE_MS) {
    this.finish()
    this.stage = "idle"
    this.idleMs = idleMs
    this.touch()
  }
  async close() {
    if (this.signal.aborted) return
    clearTimeout(this.timer)
    this.parentSignal.removeEventListener("abort", this.onAbort)
    this.controller.abort()
    await this.socket?.close().catch(() => {})
  }
}
async function readEnvelope(request) {
  const reader = request.body?.getReader()
  if (!reader) throw new Error("missing_body")
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_REQUEST_BYTES * 2) throw new Error("request_limit")
      chunks.push(value)
    }
  } catch (e) {
    await reader.cancel().catch(() => {})
    throw e
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}
export function failure(code, message) {
  return Response.json(
    { code, message, data: null },
    {
      status: code,
      headers: { "Cache-Control": "no-store", "X-OpenList-Gateway-Error": "1" },
    },
  )
}
export function failureReason(error) {
  const text = String(error?.message || "").toLowerCase()
  if (/certificate|issuer|validity/.test(text)) return "certificate_validation"
  if (/signature|finish message|mac mismatch|decrypt/.test(text))
    return "tls_verification"
  if (/target_connection_rejected/.test(text)) return "target_rejected"
  if (/node_rejected_session/.test(text)) return "node_rejected"
  if (/peer_closed|truncated/.test(text)) return "peer_closed"
  if (/request_cancelled|abort/.test(text)) return "request_cancelled"
  if (/different request|i\/o.*behalf/.test(text)) return "io_context"
  if (/padding|anytls/.test(text)) return "anytls_protocol"
  if (/alert/.test(text)) return "tls_alert"
  return "transport_failure"
}
export function createGateway({
  connect,
  openTunnel = openAnyTls,
  secure = wrapTls,
  reuseSessions = false,
  trusted = false,
}) {
  const tunnels =
    reuseSessions && openTunnel === openAnyTls
      ? new AnyTlsSessionPool({ connect, Scope: RequestScope })
      : undefined
  const pool = new ApiConnectionPool({
    connect,
    openTunnel: tunnels ? (...args) => tunnels.open(...args) : openTunnel,
    secure,
    Scope: RequestScope,
  })
  return {
    close: async () => {
      await pool.close()
      await tunnels?.close()
    },
    async fetch(request, env) {
      if (!trusted && !authorized(request, env.GATEWAY_TOKEN))
        return failure(401, "网关密钥无效")
      const path = new URL(request.url).pathname
      if (path === "/health" && request.method === "GET")
        return Response.json(
          { ok: true, transport: "anytls" },
          { headers: { "Cache-Control": "no-store" } },
        )
      if (path !== "/v1/request") return failure(404, "接口不存在")
      if (request.method !== "POST") return failure(405, "请使用 POST 请求网关")
      let input
      let envelope
      try {
        envelope = await readEnvelope(request)
        input = validateRequest(envelope, env.ALLOWED_HOSTS || DEFAULT_HOSTS)
      } catch {
        return failure(400, "目标地址、请求头或请求体不符合网关规则")
      }
      const port = Number(env.ANYTLS_PORT)
      if (
        !env.ANYTLS_SERVER ||
        !env.ANYTLS_PASSWORD ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      )
        return failure(503, "网关节点尚未配置")
      if (
        reuseSessions &&
        ["proapi.115.com", "passportapi.115.com"].includes(
          input.target.hostname,
        )
      ) {
        try {
          input = validateRequest(
            envelope,
            env.ALLOWED_HOSTS || DEFAULT_HOSTS,
            { keepAlive: true },
          )
          return await pool.fetch(request, input, env)
        } catch (error) {
          console.warn(
            JSON.stringify({
              event: "anytls_pool_failure",
              reason: failureReason(error),
            }),
          )
          return failure(502, "代理网关 API 连接失败")
        }
      }
      const scope = new RequestScope(request.signal)
      try {
        const tunnel = await openTunnel(connect, env, input.target, scope)
        scope.stage = "target_tls"
        const target = await secure(input.target.hostname, tunnel, scope)
        if (
          target.metadata.selectedAlpn &&
          target.metadata.selectedAlpn !== "http/1.1"
        )
          throw new Error("unexpected_alpn")
        scope.stage = "request_write"
        await target.write(input.bytes)
        scope.stage = "response_headers"
        const response = await readHttpResponse(target, input.method, scope)
        response.headers.set("X-OpenList-Gateway-Upstream", "1")
        response.headers.set(
          "Server-Timing",
          scope.timings.map(([name, ms]) => `${name};dur=${ms}`).join(", "),
        )
        return new Response(response.body, {
          status: response.status,
          headers: response.headers,
        })
      } catch (error) {
        const reason = scope.timedOut ? "timeout" : failureReason(error)
        console.warn(
          JSON.stringify({
            event: "anytls_failure",
            stage: scope.stage,
            reason,
            errorType: [
              "Error",
              "TypeError",
              "RangeError",
              "DOMException",
            ].includes(error?.name)
              ? error.name
              : "Error",
          }),
        )
        await scope.close()
        return failure(
          scope.timedOut ? 504 : 502,
          `代理网关连接失败（${scope.stage}: ${reason}）`,
        )
      }
    },
  }
}
