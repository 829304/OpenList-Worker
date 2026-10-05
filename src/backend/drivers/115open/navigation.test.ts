import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { Pan115Driver } from "./driver"
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test("fresh directory drivers use cached parent IDs and validate tokens with actual file requests", async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    assert.equal(url.pathname, "/open/ufile/files")
    assert.equal(url.searchParams.get("cid"), "100")
    return Response.json({ state: true, code: 0, data: [], count: 0 })
  }) as typeof fetch
  const driver = new Pan115Driver({ root_id: "0", access_token: "provider" })
  await driver.init({ validateCredentials: false })
  driver.seedFolderIds("/", [
    {
      name: "media",
      is_dir: true,
      sign: "100",
      size: 0,
      modified: "",
      type: 1,
    },
  ])
  assert.deepEqual(await driver.list("/115/media", "/media"), [])
  assert.deepEqual(calls, ["/open/ufile/files"])
})

test("explicit initialization still rejects invalid credentials; lazy initialization does not hide directory auth errors", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      state: false,
      code: 40140125,
      message: "expired",
    })) as typeof fetch
  await assert.rejects(
    new Pan115Driver({ access_token: "expired" }).init(),
    /token 验证失败/,
  )
  const driver = new Pan115Driver({ access_token: "expired" })
  await driver.init({ validateCredentials: false })
  await assert.rejects(driver.list("/115", "/"))
})
