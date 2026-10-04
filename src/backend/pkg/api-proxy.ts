/** Authenticated HTTP gateway transport; provider credentials stay in the request body. */
export interface ApiProxyConfig {
  endpoint: string
  token: string
}

export class ApiProxyError extends Error {
  constructor(
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = "ApiProxyError"
  }
}

export function getApiProxyConfig(addition: unknown): ApiProxyConfig | null {
  let value: any = addition
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      throw new ApiProxyError("代理配置格式无效")
    }
  }
  const raw = String(value?.api_proxy_url ?? "").trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ApiProxyError("API 代理地址无效，请填写 HTTPS 网关地址")
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ApiProxyError(
      "API 代理地址必须为 HTTPS，且不能包含账号、查询参数或片段",
    )
  }
  const token = String(value?.api_proxy_token ?? "").trim()
  if (token.length < 16 || /[\x00-\x20\x7f]/.test(token))
    throw new ApiProxyError("填写 API 代理地址时必须同时填写有效的代理密钥")
  const path = url.pathname.replace(/\/+$/, "")
  url.pathname = path.endsWith("/v1/request") ? path : `${path}/v1/request`
  return { endpoint: url.toString(), token }
}

export async function fetchViaApiProxy(
  target: string,
  init: RequestInit,
  config: ApiProxyConfig | null,
): Promise<Response> {
  if (!config) return fetch(target, init)
  if (
    init.body !== undefined &&
    init.body !== null &&
    typeof init.body !== "string" &&
    !(init.body instanceof URLSearchParams)
  ) {
    throw new ApiProxyError("API 代理仅支持文本或表单请求体")
  }
  const headers = new Headers(init.headers)
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      url: target,
      method: init.method || "GET",
      headers: [...headers],
      body: init.body == null ? null : String(init.body),
    }),
    signal: init.signal,
    redirect: "manual",
  })
  if (response.headers.get("x-openlist-gateway-error") === "1") {
    await response.body?.cancel().catch(() => {})
    throw new ApiProxyError(
      `API 代理网关请求失败（HTTP ${response.status}）`,
      response.status === 502 || response.status === 504,
    )
  }
  const headLength = response.headers.get("x-openlist-gateway-head-length")
  if (init.method === "HEAD" && headLength && /^\d+$/.test(headLength)) {
    const resultHeaders = new Headers(response.headers)
    resultHeaders.set("content-length", headLength)
    resultHeaders.delete("x-openlist-gateway-head-length")
    return new Response(null, {
      status: response.status,
      headers: resultHeaders,
    })
  }
  return response
}
