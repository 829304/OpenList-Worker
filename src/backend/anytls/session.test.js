import assert from "node:assert/strict"
import { test } from "node:test"
import { AsyncQueue, ByteReader, encode } from "./bytes.js"
import { frame } from "./protocol.js"
import { AnyTlsSessionPool } from "./session.js"
import { RequestScope } from "./handler.js"

const env = {
  ANYTLS_SERVER: "airport.test",
  ANYTLS_PORT: "443",
  ANYTLS_PASSWORD: "private",
}
const target = new URL("https://proapi.115.com/")
const scope = () => new RequestScope(new AbortController().signal)
function airport() {
  const nodes = []
  const pool = new AnyTlsSessionPool({
    connect() {},
    Scope: RequestScope,
    async openNode(_connect, _env, lifetime) {
      const queue = new AsyncQueue()
      const node = { queue, ids: [], finishes: [], closed: false }
      nodes.push(node)
      lifetime.socket = {
        async close() {
          node.closed = true
          queue.finish()
        },
      }
      lifetime.stage = "node_tls"
      return {
        incoming: new ByteReader(() => queue.read()),
        async send(bytes) {
          for (let offset = 0; offset < bytes.length; ) {
            const view = new DataView(
              bytes.buffer,
              bytes.byteOffset + offset,
              bytes.length - offset,
            )
            const cmd = view.getUint8(0),
              id = view.getUint32(1),
              size = view.getUint16(5)
            if (cmd === 1) {
              node.ids.push(id)
              queue.push(frame(7, id))
              queue.push(frame(2, id, new Uint8Array([id])))
            }
            if (cmd === 3) node.finishes.push(id)
            offset += 7 + size
          }
        },
      }
    },
  })
  return { pool, nodes }
}

test("upstream closure opens a new stream on the same authenticated airport session", async () => {
  const { pool, nodes } = airport(),
    a = scope(),
    b = scope()
  try {
    const first = await pool.open(null, env, target, a)
    assert.deepEqual(await first.read(), new Uint8Array([1]))
    nodes[0].queue.push(frame(3, 1))
    assert.equal(await first.read(), undefined)
    const second = await pool.open(null, env, target, b)
    assert.deepEqual(await second.read(), new Uint8Array([2]))
    assert.equal(nodes.length, 1)
    assert.equal(b.nodeReused, true)
    assert.deepEqual(nodes[0].ids, [1, 2])
    assert.ok(b.timings.some(([name]) => name === "target_connect"))
  } finally {
    await a.close()
    await b.close()
    await pool.close()
  }
})

test("cancellation and target rejection affect only their stream; node failure closes all streams", async () => {
  const { pool, nodes } = airport(),
    a = scope(),
    b = scope(),
    c = scope()
  try {
    const first = await pool.open(null, env, target, a)
    const second = await pool.open(
      null,
      env,
      new URL("https://passportapi.115.com/"),
      b,
    )
    await first.read()
    await second.read()
    await a.close()
    await assert.rejects(first.read(), /request_cancelled/)
    assert.equal(nodes[0].closed, false)
    nodes[0].queue.push(frame(7, 2, encode("sensitive-node-message")))
    await assert.rejects(
      second.read(),
      (e) => e.message === "target_connection_rejected",
    )
    const third = await pool.open(null, env, target, c)
    await third.read()
    assert.equal(nodes.length, 1)
    nodes[0].queue.push(frame(5, 0, encode("sensitive-node-message")))
    await assert.rejects(third.read(), (e) => e.message === "node_peer_closed")
    assert.equal(nodes[0].closed, true)
  } finally {
    await a.close()
    await b.close()
    await c.close()
    await pool.close()
  }
})

test("idle airport sessions are bounded and released, then re-created on demand", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 })
  const { pool, nodes } = airport(),
    a = scope()
  let b
  try {
    const first = await pool.open(null, env, target, a)
    await first.read()
    await a.close()
    t.mock.timers.tick(120001)
    assert.equal(nodes[0].closed, true)
    b = scope()
    const second = await pool.open(null, env, target, b)
    await second.read()
    assert.equal(nodes.length, 2)
    assert.equal(b.nodeReused, false)
  } finally {
    await a.close()
    await b?.close()
    await pool.close()
    t.mock.timers.reset()
  }
})

test("an active stream does not inherit the node idle deadline; rotated closed nodes release capacity", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 })
  const { pool, nodes } = airport()
  const scopes = []
  try {
    for (let index = 0; index < 6; index++) {
      const current = scope()
      scopes.push(current)
      const stream = await pool.open(
        null,
        { ...env, ANYTLS_PASSWORD: `rotation-${index}` },
        target,
        current,
      )
      await stream.read()
      // API request deadlines are managed by their caller; simulate a healthy long response.
      current.finish()
      t.mock.timers.tick(120001)
      assert.equal(nodes[index].closed, false)
      await stream.write(new Uint8Array([1]))
      await current.close()
      t.mock.timers.tick(120001)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(nodes[index].closed, true)
    }
    assert.equal(pool.entries.size, 0)
    assert.equal(pool.sessions.size, 0)
  } finally {
    for (const current of scopes) await current.close()
    await pool.close()
    t.mock.timers.reset()
  }
})
