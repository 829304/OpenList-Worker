import assert from "node:assert/strict"
import { test } from "node:test"
import { DirectoryCache, directoryCacheScope } from "./directory-cache"
import type { FileItem } from "../driver/base"

const item = (name = "file.txt"): FileItem => ({
  name,
  size: 1,
  is_dir: false,
  modified: "2026-10-05",
  sign: "1",
  type: 4,
})
const origin = "https://openlist.test"
function backend() {
  const entries = new Map<string, Response>()
  return {
    async match(key: RequestInfo | URL) {
      return entries.get(String(key))?.clone()
    },
    async put(key: RequestInfo | URL, response: Response) {
      entries.set(String(key), response.clone())
    },
    async delete(key: RequestInfo | URL) {
      return entries.delete(String(key))
    },
  }
}

test("directory cache shares raw listings between isolates, but never shares mutated results", async () => {
  const edge = backend()
  const a = new DirectoryCache(async () => edge)
  const b = new DirectoryCache(async () => edge)
  let loads = 0
  const load = async () => {
    loads++
    return [item()]
  }
  const first = await a.list("account-a", origin, "/dir", 30, false, load)
  first[0].name = "user-filtered"
  assert.equal(
    (await b.list("account-a", origin, "/dir", 30, false, load))[0].name,
    "file.txt",
  )
  assert.equal(loads, 1)
  await b.list("account-b", origin, "/dir", 30, false, load)
  assert.equal(loads, 2)
})

test("refresh replaces listings; expiration and zero TTL require a new provider request", async () => {
  let now = 0,
    loads = 0
  const cache = new DirectoryCache(
    async () => backendCache,
    () => now,
  )
  const backendCache = backend()
  const load = async () => [item(String(++loads))]
  assert.equal(
    (await cache.list("a", origin, "/dir", 1, false, load))[0].name,
    "1",
  )
  assert.equal(
    (await cache.list("a", origin, "/dir", 1, true, load))[0].name,
    "2",
  )
  assert.equal(
    (await cache.list("a", origin, "/dir", 1, false, load))[0].name,
    "2",
  )
  now = 60001
  assert.equal(
    (await cache.list("a", origin, "/dir", 1, false, load))[0].name,
    "3",
  )
  await cache.list("a", origin, "/dir", 0, false, load)
  await cache.list("a", origin, "/dir", 0, false, load)
  assert.equal(loads, 5)
})

test("mutations invalidate descendants in other isolates and cannot revive an in-flight old listing", async () => {
  const edge = backend(),
    a = new DirectoryCache(async () => edge),
    b = new DirectoryCache(async () => edge)
  await a.list("a", origin, "/dir/child", 30, false, async () => [item("old")])
  let resolve!: (items: FileItem[]) => void
  let began!: () => void
  const started = new Promise<void>((r) => {
    began = r
  })
  const pending = a.list("a", origin, "/dir/other", 30, false, () => {
    began()
    return new Promise<FileItem[]>((r) => {
      resolve = r
    })
  })
  await started
  await b.invalidate("a", origin)
  resolve([item("old")])
  await pending
  assert.equal(
    (
      await a.list("a", origin, "/dir/child", 30, false, async () => [
        item("new"),
      ])
    )[0].name,
    "new",
  )
  assert.equal(
    (
      await b.list("a", origin, "/dir/other", 30, false, async () => [
        item("new"),
      ])
    )[0].name,
    "new",
  )
})

test("concurrent misses share one load; errors are never cached, and cache failure does not block listing", async () => {
  const cache = new DirectoryCache(async () => {
    throw Error("cache unavailable")
  })
  let loads = 0
  let resolve!: (items: FileItem[]) => void
  let began!: () => void
  const started = new Promise<void>((r) => {
    began = r
  })
  const load = () => {
    loads++
    began()
    return new Promise<FileItem[]>((r) => {
      resolve = r
    })
  }
  const first = cache.list("a", origin, "/dir", 30, false, load)
  const second = cache.list("a", origin, "/dir", 30, false, load)
  await started
  resolve([item()])
  await Promise.all([first, second])
  assert.equal(loads, 1)
  await assert.rejects(
    cache.list("a", origin, "/bad", 30, false, async () => {
      throw Error("provider")
    }),
    /provider/,
  )
  assert.equal(
    (await cache.list("a", origin, "/bad", 30, false, async () => [item()]))
      .length,
    1,
  )
})

test("cache scope changes with storage configuration and does not expose credentials", async () => {
  const a = {
    id: "a",
    addition: JSON.stringify({ access_token: "private-token" }),
  }
  const hash = await directoryCacheScope(a)
  assert.match(hash, /^[a-f0-9]{64}$/)
  assert.notEqual(hash, await directoryCacheScope({ ...a, id: "b" }))
  assert.notEqual(hash, await directoryCacheScope({ ...a, modified: "new" }))
})

test("peek shares parent folder IDs across instances without loading a miss and respects expiry and invalidation", async () => {
  const edge = backend()
  let now = 0
  const a = new DirectoryCache(
    async () => edge,
    () => now,
  )
  const b = new DirectoryCache(
    async () => edge,
    () => now,
  )
  assert.equal(await b.peek("a", origin, "/missing"), undefined)
  await a.list("a", origin, "/115", 1, false, async () => [
    { ...item("media"), is_dir: true, sign: "100" },
  ])
  const parent = await b.peek("a", origin, "/115")
  assert.equal(parent?.[0].sign, "100")
  parent![0].sign = "mutated"
  assert.equal((await b.peek("a", origin, "/115"))?.[0].sign, "100")
  now = 60001
  assert.equal(await b.peek("a", origin, "/115"), undefined)
  await a.list("a", origin, "/115", 1, true, async () => [item()])
  await a.invalidate("a", origin)
  assert.equal(await b.peek("a", origin, "/115"), undefined)
})
