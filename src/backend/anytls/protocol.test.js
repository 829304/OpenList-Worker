import assert from "node:assert/strict"
import { test } from "node:test"
import { ByteReader, concat, encode } from "./bytes.js"
import { frame, openAnyTls, padPacket, parsePadding } from "./protocol.js"

test("AnyTLS framing survives packet splitting and waste padding", async () => {
  const data = concat(frame(1, 1), frame(2, 1, new Uint8Array([1, 2, 3, 4])))
  const scheme = parsePadding("stop=3\n0=30-30\n1=9-9,30-30\n2=20-20,c,30-30")
  const packets = padPacket(data, 1, scheme, ([lo]) => lo)
  assert.deepEqual(
    packets.map((p) => p.length),
    [9, 30],
  )
  let offset = 0
  const stream = new ByteReader(async () => packets[offset++])
  assert.deepEqual(await stream.exact(data.length), data)
  assert.equal((await stream.exact(7))[0], 0)
  assert.equal(padPacket(new Uint8Array(5), 2, scheme, ([lo]) => lo).length, 1)
})
test("malformed or excessive server padding schemes are rejected", () => {
  for (const value of [
    "stop=1000",
    "stop=1\n0=c",
    "stop=1\n0=5-1",
    "stop=1\n0=1-65536",
  ])
    assert.throws(() => parsePadding(value))
})

test("a padding update from one TCP session cannot change another session's authentication", async () => {
  const lengths = []
  for (let i = 0; i < 2; i++) {
    let response = concat(
      frame(6, 0, encode("stop=2\n0=12-12\n1=20-20")),
      frame(2, 1, new Uint8Array([123])),
    )
    const tunnel = await openAnyTls(
      () => ({
        opened: Promise.resolve(),
        closed: Promise.resolve(),
        readable: new ReadableStream(),
        writable: new WritableStream(),
      }),
      {
        ANYTLS_SERVER: "node.test",
        ANYTLS_PORT: "443",
        ANYTLS_PASSWORD: "test-password",
      },
      new URL("https://proapi.115.com/"),
      {
        signal: new AbortController().signal,
        touch() {},
      },
      {
        async secure() {
          let writes = 0
          return {
            async write(bytes) {
              if (!writes++)
                lengths.push(
                  new DataView(
                    bytes.buffer,
                    bytes.byteOffset,
                    bytes.byteLength,
                  ).getUint16(32),
                )
            },
            async read() {
              const value = response
              response = undefined
              return value
            },
          }
        },
      },
    )
    assert.deepEqual(await tunnel.read(), new Uint8Array([123]))
  }
  assert.deepEqual(lengths, [30, 30])
})
