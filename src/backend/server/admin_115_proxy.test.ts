import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { adminRouter } from "./admin"
import { getDb, saveDb } from "../internal/model/db"

test("switching to internal 115 proxy preserves rotated tokens in the final admin save", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    assert.fail("external gateway must not be used")) as typeof fetch
  let attempts = 0
  const env = {
    ANYTLS_SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          const value: any = await request.json()
          if (value.url.includes("refreshToken"))
            return Response.json({
              state: true,
              code: 0,
              data: { access_token: "fresh", refresh_token: "fresh-refresh" },
            })
          if (!attempts++)
            return Response.json({ state: false, code: 40140125 })
          return Response.json({ state: true, code: 0, data: { user_id: 1 } })
        },
      }),
    },
  }
  const storage: any = {
    id: "admin-115-proxy",
    driver: "115Open",
    mount_path: "/115",
    status: "work",
    disabled: false,
    modified: "old",
    addition: JSON.stringify({
      access_token: "expired",
      refresh_token: "old-refresh",
      api_proxy_url: "https://old-gateway.test",
      api_proxy_token: "long-old-gateway-token",
    }),
  }
  const db: any = {
    settings: [{ key: "token", value: "admin-token" }],
    users: [],
    storages: [storage],
    metas: [],
    shares: [],
  }
  const app = new Hono()
  app.route("/api/admin", adminRouter)
  try {
    await saveDb(db, env)
    const response = await app.request(
      "/api/admin/storage/update",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "admin-token",
        },
        body: JSON.stringify({
          ...storage,
          addition: JSON.stringify({
            access_token: "expired",
            refresh_token: "old-refresh",
            api_proxy_internal: true,
          }),
        }),
      },
      env,
    )
    assert.equal(((await response.json()) as any).code, 200)
    const addition = JSON.parse((await getDb(env)).storages[0].addition)
    assert.equal(addition.api_proxy_internal, true)
    assert.equal(addition.access_token, "fresh")
    assert.equal(addition.refresh_token, "fresh-refresh")
    assert.equal(addition.api_proxy_url, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})
