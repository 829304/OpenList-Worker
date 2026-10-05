import assert from "node:assert/strict"
import { test } from "node:test"
import { createGateway } from "./handler.js"
import { AsyncQueue, encode } from "./bytes.js"

const env = {
  GATEWAY_TOKEN: "random-gateway-token-32-characters",
  ANYTLS_SERVER: "node.test",
  ANYTLS_PORT: "443",
  ANYTLS_PASSWORD: "secret",
}
const request = (
  url = "https://proapi.115.com/open/user/info",
  method = "GET",
  auth = "account-a",
) =>
  new Request("https://gateway.test/v1/request", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GATEWAY_TOKEN}` },
    body: JSON.stringify({
      url,
      method,
      headers: [["Authorization", auth]],
      body: null,
    }),
  })

test("API requests reuse verified TLS, serialize responses, and preserve each account's headers", async () => {
  let opens = 0,
    writes = 0
  const gateway = createGateway({
    reuseSessions: true,
    connect() {},
    async openTunnel(_connect, _env, _target, scope) {
      opens++
      scope.socket = { async close() {} }
      return {}
    },
    async secure() {
      const queue = new AsyncQueue()
      return {
        metadata: { selectedAlpn: "http/1.1" },
        closed: () => false,
        read: () => queue.read(),
        async write(bytes) {
          const text = new TextDecoder().decode(bytes)
          assert.match(text, /connection: keep-alive/i)
          assert.match(text, /authorization: account-[ab]/i)
          const payload = JSON.stringify({
            sequence: ++writes,
            account: text.match(/authorization: ([^\r]+)/i)[1],
          })
          queue.push(
            encode(
              `HTTP/1.1 200 OK\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`,
            ),
          )
        },
      }
    },
  })
  try {
    const first = await gateway.fetch(request(), env)
    const [a, b] = await Promise.all([
      gateway.fetch(request(undefined, "GET", "account-a"), env),
      gateway.fetch(request(undefined, "GET", "account-b"), env),
    ])
    assert.equal(first.headers.get("x-openlist-gateway-connection"), "new")
    assert.equal(a.headers.get("x-openlist-gateway-connection"), "reused")
    assert.equal(b.headers.get("x-openlist-gateway-connection"), "reused")
    assert.equal(opens, 1)
    assert.deepEqual(await a.json(), { sequence: 2, account: "account-a" })
    assert.deepEqual(await b.json(), { sequence: 3, account: "account-b" })
  } finally {
    await gateway.close()
  }
})

test("Connection: close prevents reuse; reused POST failures are never replayed", async () => {
  let opens = 0,
    writes = 0,
    closes = 0
  const gateway = createGateway({
    reuseSessions: true,
    connect() {},
    async openTunnel(_connect, _env, _target, scope) {
      opens++
      scope.socket = {
        async close() {
          closes++
        },
      }
      return {}
    },
    async secure() {
      const queue = new AsyncQueue(),
        number = opens
      return {
        metadata: {},
        closed: () => false,
        read: () => queue.read(),
        async write() {
          writes++
          if (writes === 3) throw Error("stale connection")
          queue.push(
            encode(
              `HTTP/1.1 200 OK\r\n${number === 1 ? "Connection: close\r\n" : ""}Content-Length: 2\r\n\r\n{}`,
            ),
          )
        },
      }
    },
  })
  try {
    assert.equal((await gateway.fetch(request(), env)).status, 200)
    assert.equal((await gateway.fetch(request(), env)).status, 200)
    assert.equal(opens, 2)
    assert.equal(
      (await gateway.fetch(request(undefined, "POST"), env)).status,
      502,
    )
    assert.equal(writes, 3)
    assert.equal(closes, 2)
  } finally {
    await gateway.close()
  }
})

test("a stale reused GET reconnects once; truncated bodies discard the connection", async () => {
  let opens = 0,
    writes = 0
  const gateway = createGateway({
    reuseSessions: true,
    connect() {},
    async openTunnel(_connect, _env, _target, scope) {
      opens++
      scope.socket = { async close() {} }
      return {}
    },
    async secure() {
      const queue = new AsyncQueue()
      return {
        metadata: {},
        closed: () => false,
        read: () => queue.read(),
        async write() {
          writes++
          if (writes === 2) throw Error("stale connection")
          queue.push(
            encode(
              `HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n${writes === 4 ? "{" : "{}"}`,
            ),
          )
          if (writes === 4) queue.finish()
        },
      }
    },
  })
  try {
    assert.equal((await gateway.fetch(request(), env)).status, 200)
    assert.equal((await gateway.fetch(request(), env)).status, 200)
    assert.equal(opens, 2)
    assert.equal(writes, 3)
    assert.equal(
      (await gateway.fetch(request(undefined, "POST"), env)).status,
      502,
    )
    assert.equal((await gateway.fetch(request(), env)).status, 200)
    assert.equal(opens, 3)
    assert.equal(writes, 5)
  } finally {
    await gateway.close()
  }
})

test("browsing pauses reuse connections; idle and age limits still release sockets without interrupting a response", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 })
  let opens = 0,
    writes = 0,
    closes = 0,
    connectionScope
  const gateway = createGateway({
    reuseSessions: true,
    connect() {},
    async openTunnel(_connect, _env, _target, scope) {
      opens++
      connectionScope = scope
      scope.socket = {
        async close() {
          closes++
        },
      }
      return {}
    },
    async secure() {
      const queue = new AsyncQueue()
      const scope = connectionScope
      return {
        metadata: {},
        closed: () => false,
        read: () => queue.read(),
        async write() {
          // The final request crosses the age limit while it is active.
          if (++writes === 5) t.mock.timers.tick(2)
          assert.equal(scope.signal.aborted, false)
          queue.push(encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"))
        },
      }
    },
  })
  const fetch = async () => {
    const response = await gateway.fetch(request(), env)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {})
    return response.headers.get("x-openlist-gateway-connection")
  }
  try {
    assert.equal(await fetch(), "new")
    // Neither a normal browsing pause nor reaching the old 60s age limit
    // should force another handshake.
    for (const pause of [12001, 65000, 110000, 112998]) {
      t.mock.timers.tick(pause)
      assert.equal(await fetch(), "reused")
    }
    assert.equal(opens, 1)
    assert.equal(closes, 1) // Finished response at age > 5 minutes.
    assert.equal(await fetch(), "new")
    t.mock.timers.tick(120001)
    assert.equal(closes, 2) // No request is needed to release an idle socket.
    assert.equal(await fetch(), "new")
    assert.equal(opens, 3)
  } finally {
    await gateway.close()
    t.mock.timers.reset()
  }
})
