import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { Pan115Client } from "./util"
import {
  ApiProxyError,
  fetchViaApiProxy,
  getApiProxyConfig,
} from "../../pkg/api-proxy"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const proxy = {
  api_proxy_url: "https://gateway.example.com/",
  api_proxy_token: "gateway-token-at-least-32-characters",
}

test("115 blank proxy uses the original target without gateway authentication", async () => {
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://proapi.115.com/open/user/info")
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer provider-token",
    )
    return Response.json({ state: true, code: 0, data: { user_id: 1 } })
  }) as typeof fetch
  assert.equal(
    (
      await new Pan115Client({
        access_token: "provider-token",
        api_proxy_url: "  ",
      }).userInfo()
    ).user_id,
    1,
  )
})
test("115 proxies API and token refresh, preserving cookies, forms and caller UA", async () => {
  const calls: any[] = []
  let fileRequests = 0,
    updated: any
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://gateway.example.com/v1/request")
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${proxy.api_proxy_token}`,
    )
    const body = JSON.parse(String(init?.body))
    calls.push(body)
    const headers = new Headers(body.headers)
    if (body.url.includes("/open/refreshToken")) {
      assert.equal(body.url, "https://passportapi.115.com/open/refreshToken")
      assert.equal(body.body, "refresh_token=refresh-old")
      assert.equal(headers.get("authorization"), null)
      return Response.json({
        state: true,
        code: 0,
        data: {
          access_token: "fresh-provider-token",
          refresh_token: "refresh-new",
        },
      })
    }
    assert.equal(headers.get("user-agent"), "Caller-UA")
    assert.equal(body.body, "pick_code=pick-code")
    if (!fileRequests++)
      return Response.json(
        { state: false, code: 40140125 },
        { headers: { "Set-Cookie": "LB=sticky; Path=/; Secure" } },
      )
    assert.equal(headers.get("cookie"), "LB=sticky")
    assert.equal(headers.get("authorization"), "Bearer fresh-provider-token")
    return Response.json({
      state: true,
      code: 0,
      data: { file: { url: { url: "https://cdn.115cdn.net/file" } } },
    })
  }) as typeof fetch
  const client = new Pan115Client(
    {
      ...proxy,
      access_token: "old-provider-token",
      refresh_token: "refresh-old",
    },
    (tokens) => {
      updated = tokens
    },
  )
  await client.downUrl("pick-code", "Caller-UA")
  assert.equal(calls.length, 3)
  assert.equal(updated.refresh_token, "refresh-new")
})
test("invalid proxy configuration and gateway rejection never fall back to direct access", async () => {
  for (const url of [
    "http://gateway.example.com",
    "https://user:pass@gateway.example.com",
    "https://gateway.example.com?token=secret",
  ])
    assert.throws(
      () => getApiProxyConfig({ ...proxy, api_proxy_url: url }),
      ApiProxyError,
    )
  assert.throws(
    () => getApiProxyConfig({ api_proxy_url: proxy.api_proxy_url }),
    /代理密钥/,
  )
  let calls = 0
  globalThis.fetch = (async (input, init) => {
    calls++
    assert.equal(String(input), "https://gateway.example.com/v1/request")
    assert.equal(init?.redirect, "manual")
    return Response.json(
      { message: "provider-token must not appear in exception" },
      { status: 401, headers: { "X-OpenList-Gateway-Error": "1" } },
    )
  }) as typeof fetch
  await assert.rejects(
    new Pan115Client({ ...proxy, access_token: "provider-token" }).userInfo(),
    (error) =>
      error instanceof Error &&
      /HTTP 401/.test(error.message) &&
      !/provider-token/.test(error.message),
  )
  assert.equal(calls, 1)
})
test("gateway download transport preserves Range and restores HEAD metadata", async () => {
  globalThis.fetch = (async (_input, init) => {
    const envelope = JSON.parse(String(init?.body))
    assert.equal(new Headers(envelope.headers).get("range"), "bytes=0-31")
    return new Response(null, {
      headers: { "X-OpenList-Gateway-Head-Length": "1000" },
    })
  }) as typeof fetch
  const response = await fetchViaApiProxy(
    "https://cdn.115cdn.net/file",
    { method: "HEAD", headers: { Range: "bytes=0-31" } },
    getApiProxyConfig(proxy),
  )
  assert.equal(response.headers.get("content-length"), "1000")
  assert.equal(response.headers.get("x-openlist-gateway-head-length"), null)
})
