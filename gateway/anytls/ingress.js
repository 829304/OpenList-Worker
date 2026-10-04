import { authorized, failure } from "./handler.js"

// Keep the public Worker within its 10ms Free CPU budget. TLS and response
// processing execute entirely inside a separate Durable Object for each request.
export function createIngress() {
  return {
    async fetch(request, env) {
      if (!authorized(request, env.GATEWAY_TOKEN))
        return failure(401, "网关密钥无效")
      const path = new URL(request.url).pathname
      if (path === "/health" && request.method === "GET")
        return Response.json(
          {
            ok: Boolean(env.ANYTLS_SESSIONS),
            transport: "anytls",
            runtime: "durable-object",
          },
          { headers: { "Cache-Control": "no-store" } },
        )
      if (path !== "/v1/request") return failure(404, "接口不存在")
      if (request.method !== "POST") return failure(405, "请使用 POST 请求网关")
      if (!env.ANYTLS_SESSIONS) return failure(503, "网关会话服务尚未配置")
      try {
        const id = env.ANYTLS_SESSIONS.newUniqueId()
        const session = env.ANYTLS_SESSIONS.get(id, { locationHint: "apac" })
        return await session.fetch(request)
      } catch {
        return failure(502, "代理网关会话执行失败，请稍后重试")
      }
    },
  }
}
