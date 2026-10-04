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

test("115 API gateway does not override the storage redirect policy", () => {
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
    assert.equal(decision.mode, "302_redirect")
    assert.equal(decision.needsProxy, false)
  }
})

for (const mode of ["redirect", "proxy", "range-retry"] as const) {
  test(`115 API gateway keeps file delivery separate: ${mode}`, async () => {
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
            id: `gateway-${mode}`,
            webdav_policy:
              mode === "redirect" ? "302_redirect" : "native_proxy",
            web_proxy: false,
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
      if (String(input) === target) {
        assert.notEqual(
          mode,
          "redirect",
          "302 must not fetch the file in Worker",
        )
        const headers = new Headers(init?.headers)
        assert.equal(headers.get("authorization"), null)
        assert.equal(headers.get("user-agent"), "Download-UA")
        downloads++
        if (downloads === 1) {
          assert.equal(headers.get("range"), "bytes=0-3")
          if (mode === "range-retry") return new Response(null, { status: 412 })
        } else assert.equal(headers.get("range"), null)
        return new Response("test", {
          status: mode === "range-retry" ? 200 : 206,
          headers: {
            "Content-Length": "4",
            ...(mode === "proxy" ? { "Content-Range": "bytes 0-3/100" } : {}),
          },
        })
      }
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
      assert.fail("Only 115 API requests may use the API gateway")
    }) as typeof fetch
    const app = new Hono()
    app.route("/api/d", rawRouter)
    const response = await app.request(
      "/api/d/115/file.txt",
      { headers: { Range: "bytes=0-3", "User-Agent": "Download-UA" } },
      env,
    )
    if (mode === "redirect") {
      assert.equal(response.status, 302)
      assert.equal(response.headers.get("location"), target)
      assert.equal(downloads, 0)
    } else {
      assert.equal(response.status, mode === "proxy" ? 206 : 200)
      assert.equal(await response.text(), "test")
      assert.equal(downloads, mode === "range-retry" ? 2 : 1)
    }
    assert.ok(!response.headers.get("location")?.includes(token))
  })
}
