import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { Hono } from "hono"
import { saveDb } from "../internal/model/db"
import { rawRouter } from "./raw"
import { resolveProxyDecision } from "../internal/driver/proxy"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test("115 gateway requires file proxy even with an old redirect policy; blank preserves redirect", () => {
  for (const api_proxy_url of ["", "https://gateway.example.com"]) {
    const decision = resolveProxyDecision(
      {
        driver: "115Open",
        webdav_policy: "302_redirect",
        addition: JSON.stringify({ api_proxy_url }),
      },
      "115open",
      false,
    )
    assert.equal(decision.needsProxy, Boolean(api_proxy_url))
  }
})

for (const rejectRetry of [false, true]) {
  test(`115 raw download uses gateway for APIs and ${rejectRetry ? "reports Range retry failure" : "streams Range bytes"}`, async () => {
    const token = "test-gateway-token-32-characters"
    const target = "https://cdn.115cdn.net/file"
    const env: any = {}
    await saveDb(
      {
        settings: [],
        users: [],
        shares: [],
        metas: [],
        storages: [
          {
            id: `gateway-${rejectRetry}`,
            mount_path: "/115",
            driver: "115Open",
            status: "work",
            disabled: false,
            proxy_range: true,
            addition: JSON.stringify({
              access_token: "provider-token",
              root_id: "0",
              api_proxy_url: "https://gateway.example.com",
              api_proxy_token: token,
            }),
          },
        ],
      },
      env,
    )
    let downloads = 0
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), "https://gateway.example.com/v1/request")
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${token}`,
      )
      const request = JSON.parse(String(init?.body))
      const headers = new Headers(request.headers)
      assert.ok(!JSON.stringify(request).includes(token))
      if (request.url.includes("/open/user/info"))
        return Response.json({ state: true, code: 0, data: { user_id: 1 } })
      if (request.url.includes("/open/folder/get_info"))
        return Response.json({
          state: true,
          code: 0,
          data: {
            file_id: "1",
            file_category: "1",
            file_name: "file.txt",
            pick_code: "pick",
            utime: "1700000000",
            size_byte: 100,
          },
        })
      if (request.url.includes("/open/ufile/downurl")) {
        assert.equal(headers.get("user-agent"), "Download-UA")
        return Response.json({
          state: true,
          code: 0,
          data: { "1": { url: { url: target } } },
        })
      }
      assert.equal(request.url, target)
      assert.equal(headers.get("user-agent"), "Download-UA")
      downloads++
      if (downloads === 1) {
        assert.equal(headers.get("range"), "bytes=0-3")
        if (rejectRetry) return new Response(null, { status: 412 })
        return new Response("test", {
          status: 206,
          headers: { "Content-Range": "bytes 0-3/100", "Content-Length": "4" },
        })
      }
      assert.equal(headers.get("range"), null)
      return Response.json(
        { message: "hidden-secret" },
        { status: 502, headers: { "X-OpenList-Gateway-Error": "1" } },
      )
    }) as typeof fetch
    const app = new Hono()
    app.route("/api/d", rawRouter)
    const response = await app.request(
      "/api/d/115/file.txt",
      { headers: { Range: "bytes=0-3", "User-Agent": "Download-UA" } },
      env,
    )
    assert.equal(response.status, rejectRetry ? 502 : 206)
    const body = await response.text()
    if (rejectRetry) assert.match(body, /HTTP 502/)
    else assert.equal(body, "test")
    assert.ok(!body.includes(token) && !body.includes("hidden-secret"))
    assert.equal(downloads, rejectRetry ? 2 : 1)
  })
}
