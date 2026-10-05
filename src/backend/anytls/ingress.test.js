import assert from "node:assert/strict"
import { test } from "node:test"
import { createIngress } from "./ingress.js"

const token = "random-gateway-token-32-characters"
const request = (path = "/v1/request", auth = true, method = "POST") =>
  new Request(`https://gateway.test${path}`, {
    method,
    headers: auth ? { Authorization: `Bearer ${token}` } : {},
    body:
      method === "POST"
        ? JSON.stringify({ url: "https://proapi.115.com/", headers: [] })
        : undefined,
  })

test("unauthorized requests and health checks never allocate a TLS session", async () => {
  const ingress = createIngress()
  const env = {
    GATEWAY_TOKEN: token,
    ANYTLS_SESSIONS: {
      idFromName() {
        assert.fail("must not allocate")
      },
    },
  }
  assert.equal(
    (await ingress.fetch(request(undefined, false), env)).status,
    401,
  )
  const health = await ingress.fetch(request("/health", true, "GET"), env)
  assert.equal((await health.json()).runtime, "durable-object")
  assert.equal((await ingress.fetch(request("/invalid"), env)).status, 404)
  assert.equal(
    (await ingress.fetch(request(undefined, true, "GET"), env)).status,
    405,
  )
})
test("reused executors keep requests and their response streams independent", async () => {
  let next = 0
  const ingress = createIngress({ selectSession: () => 0 })
  const env = {
    GATEWAY_TOKEN: token,
    ANYTLS_SESSIONS: {
      idFromName(name) {
        assert.equal(name, "anytls-0")
        return ++next
      },
      get(id, options) {
        assert.equal(id, next)
        assert.equal(options.locationHint, "apac")
        return {
          async fetch(incoming) {
            assert.equal(
              incoming.headers.get("Authorization"),
              `Bearer ${token}`,
            )
            assert.equal((await incoming.json()).url, "https://proapi.115.com/")
            return new Response(new Uint8Array([0, 255]), {
              status: 206,
              headers: {
                "Content-Range": "bytes 0-1/100",
                "X-OpenList-Gateway-Upstream": "1",
              },
            })
          },
        }
      },
    },
  }
  for (let i = 0; i < 2; i++) {
    const response = await ingress.fetch(request(), env)
    assert.equal(response.status, 206)
    assert.equal(response.headers.get("content-range"), "bytes 0-1/100")
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      new Uint8Array([0, 255]),
    )
  }
  assert.equal(next, 2)
})
test("session runtime failures become gateway errors with no exception details", async () => {
  const ingress = createIngress()
  const env = {
    GATEWAY_TOKEN: token,
    ANYTLS_SESSIONS: {
      idFromName() {
        return 1
      },
      get() {
        return {
          fetch() {
            throw new Error("sensitive-node-password")
          },
        }
      },
    },
  }
  const response = await ingress.fetch(request(), env)
  assert.equal(response.status, 502)
  assert.equal(response.headers.get("x-openlist-gateway-error"), "1")
  assert.doesNotMatch(await response.text(), /sensitive-node-password/)
})
