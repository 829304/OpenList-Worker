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

test("Cloudflare's empty 503 is retried as a gateway failure without refreshing 115 tokens", async () => {
  let calls = 0
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://gateway.example.com/v1/request")
    assert.equal(
      new URL(JSON.parse(String(init?.body)).url).pathname,
      "/open/user/info",
    )
    if (!calls++) return new Response(null, { status: 503 })
    return Response.json(
      { state: true, code: 0, data: { user_id: 1 } },
      { headers: { "X-OpenList-Gateway-Upstream": "1" } },
    )
  }) as typeof fetch
  assert.equal(
    (
      await new Pan115Client({
        ...proxy,
        access_token: "provider-token",
      }).userInfo()
    ).user_id,
    1,
  )
  assert.equal(calls, 2)
})

test("marked 115 upstream 503 remains an upstream response", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { state: false, code: 503, message: "upstream unavailable" },
      { status: 503, headers: { "X-OpenList-Gateway-Upstream": "1" } },
    )) as typeof fetch
  const response = await fetchViaApiProxy(
    "https://proapi.115.com/open/user/info",
    {},
    getApiProxyConfig(proxy),
  )
  assert.equal(response.status, 503)
  assert.equal((await response.json()).message, "upstream unavailable")
})

test("internal proxy uses private DO bindings for APIs and token refresh, never public fetch", async () => {
  globalThis.fetch = (async () =>
    assert.fail("public network must not be used")) as typeof fetch
  const hosts: string[] = []
  let attempts = 0,
    tokens: any
  const env = {
    ANYTLS_SESSIONS: {
      idFromName(name: string) {
        return name
      },
      get(id: string, options: any) {
        assert.equal(options.locationHint, "apac")
        return {
          async fetch(request: Request) {
            assert.equal(new URL(request.url).hostname, "anytls.internal")
            const envelope: any = await request.json()
            const host = new URL(envelope.url).hostname
            assert.equal(id, `115-api-${host}`)
            hosts.push(host)
            if (host === "passportapi.115.com")
              return Response.json({
                state: true,
                code: 0,
                data: { access_token: "fresh", refresh_token: "new-refresh" },
              })
            if (!attempts++)
              return Response.json({ state: false, code: 40140125 })
            assert.equal(
              new Headers(envelope.headers).get("authorization"),
              "Bearer fresh",
            )
            return Response.json({ state: true, code: 0, data: { user_id: 1 } })
          },
        }
      },
    },
  }
  const client = new Pan115Client(
    {
      api_proxy_internal: true,
      access_token: "expired",
      refresh_token: "old-refresh",
    },
    (value) => {
      tokens = value
    },
    env,
  )
  assert.equal((await client.userInfo()).user_id, 1)
  assert.deepEqual(hosts, [
    "proapi.115.com",
    "passportapi.115.com",
    "proapi.115.com",
  ])
  assert.equal(tokens.refresh_token, "new-refresh")
})

test("internal proxy rejects CDN targets, missing binding and transport failure without direct fallback", async () => {
  globalThis.fetch = (async () =>
    assert.fail("direct fallback must not be used")) as typeof fetch
  const config = getApiProxyConfig({ api_proxy_internal: true })
  await assert.rejects(
    fetchViaApiProxy("https://cdn.115cdn.net/video", {}, config, {}),
    /只允许访问 115 API/,
  )
  await assert.rejects(
    fetchViaApiProxy("https://proapi.115.com/open/user/info", {}, config, {}),
    /未配置/,
  )
  const env = {
    ANYTLS_SESSIONS: {
      idFromName: () => "id",
      get: () => ({
        fetch: async () => {
          throw Error("private-node-details")
        },
      }),
    },
  }
  await assert.rejects(
    fetchViaApiProxy("https://proapi.115.com/open/user/info", {}, config, env),
    (error) =>
      error instanceof ApiProxyError &&
      error.retryable &&
      !error.message.includes("private-node-details"),
  )
})
