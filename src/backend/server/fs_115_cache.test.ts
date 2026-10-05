import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { saveDb } from "../internal/model/db"
import { fsRouter } from "./fs"

test("115 directory navigation caches listings, refreshes explicitly, invalidates writes, and checks permissions on hits", async () => {
  const originalFetch = globalThis.fetch
  const env: any = {}
  const storage = {
    id: "directory-cache-integration",
    driver: "115Open",
    mount_path: "/115",
    modified: "cache-test-v1",
    status: "work",
    disabled: false,
    cache_expiration: 30,
    addition: JSON.stringify({
      root_id: "0",
      access_token: "provider",
      api_proxy_url: "https://gateway.test",
      api_proxy_token: "gateway-token-at-least-32-characters",
    }),
  }
  const db = {
    settings: [{ key: "token", value: "admin-token" }],
    users: [
      {
        id: 1,
        username: "admin",
        role: 2,
        permission: 0,
        disabled: false,
        base_path: "/",
      },
      {
        id: 2,
        username: "guest",
        role: 1,
        permission: 0,
        disabled: false,
        base_path: "/",
      },
    ],
    storages: [storage],
    shares: [],
    metas: [] as any[],
  }
  const apiCalls: string[] = []
  let fileVersion = 1,
    created = false
  const file = (fid: string, fn: string, fc = "1") => ({
    fid,
    fn,
    fc,
    pid: "100",
    fs: fileVersion,
    upt: 1700000000,
    pc: "pick",
  })
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://gateway.test/v1/request")
    const request = JSON.parse(String(init?.body))
    const url = new URL(request.url)
    apiCalls.push(url.pathname)
    let data: any
    if (url.pathname === "/open/user/info") data = { user_id: 1 }
    else if (url.pathname === "/open/folder/get_info")
      data = { file_id: "100", file_name: "media", file_category: "0" }
    else if (url.pathname === "/open/folder/add") {
      created = true
      data = { file_id: "300", file_name: "new" }
    } else if (url.pathname === "/open/ufile/files") {
      const files =
        url.searchParams.get("cid") === "200"
          ? [file("201", "child.txt")]
          : [
              file("200", "child", "0"),
              file("101", "file.txt"),
              ...(created ? [file("300", "new", "0")] : []),
            ]
      return Response.json({
        state: true,
        code: 0,
        data: files,
        count: files.length,
      })
    } else assert.fail("unexpected API request")
    return Response.json({ state: true, code: 0, data })
  }) as typeof fetch
  const app = new Hono()
  app.route("/api/fs", fsRouter)
  const post = (method: string, body: any, admin = false) =>
    app.request(
      `/api/fs/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(admin ? { Authorization: "admin-token" } : {}),
        },
        body: JSON.stringify(body),
      },
      env,
    )
  try {
    await saveDb(db, env)
    const first = await post("list", { path: "/115/media" })
    assert.equal(((await first.json()) as any).code, 200)
    assert.equal(apiCalls.includes("/open/user/info"), false, "directory listing must avoid redundant credential preflight")
    const initialCalls = apiCalls.length
    const second = await post("list", { path: "/115/media" })
    assert.equal(second.headers.get("x-openlist-directory-cache"), "memory")
    assert.equal(apiCalls.length, initialCalls)

    const folderLookups = apiCalls.filter((p) => p.endsWith("get_info")).length
    await post("list", { path: "/115/media/child" })
    assert.equal(
      apiCalls.filter((p) => p.endsWith("get_info")).length,
      folderLookups,
      "parent listing should resolve child IDs without an extra API call",
    )

    fileVersion = 2
    const refresh = await post("list", { path: "/115/media", refresh: true })
    assert.equal(refresh.headers.get("x-openlist-directory-cache"), "miss")
    assert.equal(
      ((await refresh.json()) as any).data.content.find(
        (x: any) => x.name === "file.txt",
      ).size,
      2,
    )

    assert.equal(
      (
        (await (
          await post("mkdir", { path: "/115/media/new" }, true)
        ).json()) as any
      ).code,
      200,
    )
    const afterWrite = await post("list", { path: "/115/media" })
    assert.equal(afterWrite.headers.get("x-openlist-directory-cache"), "miss")
    assert.equal(((await afterWrite.json()) as any).data.content.length, 3)
    const childAfterWrite = await post("list", { path: "/115/media/child" })
    assert.equal(
      childAfterWrite.headers.get("x-openlist-directory-cache"),
      "miss",
      "writes invalidate descendants too",
    )

    db.metas = [
      { id: 1, path: "/115/media", password: "protected", inherit: true },
    ]
    await saveDb(db, env)
    const callsBeforeDenied = apiCalls.length
    assert.equal((await post("list", { path: "/115/media" })).status, 403)
    assert.equal(apiCalls.length, callsBeforeDenied)
    const unlocked = await post("list", {
      path: "/115/media",
      password: "protected",
    })
    assert.equal(((await unlocked.json()) as any).code, 200)
    assert.equal(unlocked.headers.get("x-openlist-directory-cache"), "memory")

    storage.cache_expiration = 0
    storage.modified = "cache-test-v2"
    db.metas = []
    await saveDb(db, env)
    const before = apiCalls.filter((p) => p.endsWith("/files")).length
    const uncached = await post("list", { path: "/115/media" })
    assert.equal(uncached.headers.get("x-openlist-directory-cache"), "bypass")
    await post("list", { path: "/115/media" })
    assert.equal(
      apiCalls.filter((p) => p.endsWith("/files")).length,
      before + 2,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
