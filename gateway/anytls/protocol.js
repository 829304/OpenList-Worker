import { createHash } from "node:crypto"
import { ByteReader, concat, decode, encode } from "./bytes.js"
import { wrapTls } from "./tls.js"

const DEFAULT_PADDING =
  "stop=8\n0=30-30\n1=100-400\n2=400-500,c,500-1000,c,500-1000,c,500-1000,c,500-1000\n3=9-9,500-1000\n4=500-1000\n5=500-1000\n6=500-1000\n7=500-1000"
let cachedPadding = parsePadding(DEFAULT_PADDING)

export function frame(command, id, payload = new Uint8Array()) {
  if (payload.length > 65535) throw new Error("frame_limit")
  const head = new Uint8Array(7),
    view = new DataView(head.buffer)
  view.setUint8(0, command)
  view.setUint32(1, id)
  view.setUint16(5, payload.length)
  return concat(head, payload)
}
export function parsePadding(text) {
  if (text.length > 16384) throw new Error("padding_limit")
  const lines = new Map(
    text
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  )
  const stop = Number(lines.get("stop"))
  if (!Number.isInteger(stop) || stop < 0 || stop > 64)
    throw new Error("invalid_padding")
  const rules = new Map()
  for (let packet = 0; packet < stop; packet++) {
    const values = lines.get(String(packet))
    if (values === undefined) continue
    const items = values.split(",").map((item) => {
      if (item === "c") return item
      const match = /^(\d+)-(\d+)$/.exec(item)
      if (!match) throw new Error("invalid_padding")
      const low = Number(match[1]),
        high = Number(match[2])
      if (low > high || high > 65535) throw new Error("invalid_padding")
      return [low, high]
    })
    if (
      items.length > 32 ||
      (packet === 0 && (items.length !== 1 || items[0] === "c"))
    )
      throw new Error("invalid_padding")
    rules.set(packet, items)
  }
  return { stop, rules, md5: createHash("md5").update(text).digest("hex") }
}
function pick([low, high]) {
  const random = crypto.getRandomValues(new Uint32Array(1))[0]
  return low + (random % (high - low + 1))
}
export function padPacket(data, packet, scheme, random = pick) {
  const rule = scheme.rules.get(packet)
  if (packet >= scheme.stop || !rule) return [data]
  const parts = []
  let remaining = data
  for (const entry of rule) {
    if (entry === "c") {
      if (!remaining.length) break
      continue
    }
    const size = random(entry)
    if (remaining.length >= size) {
      if (size) parts.push(remaining.slice(0, size))
      remaining = remaining.subarray(size)
    } else {
      const padding = size - remaining.length - 7
      parts.push(
        padding >= 0
          ? concat(remaining, frame(0, 0, new Uint8Array(padding)))
          : remaining,
      )
      remaining = new Uint8Array()
    }
  }
  if (remaining.length) parts.push(remaining)
  return parts.filter((part) => part.length)
}

export async function openAnyTls(connect, env, target, scope) {
  scope.stage = "node_tcp"
  const raw = connect(
    { hostname: env.ANYTLS_SERVER, port: Number(env.ANYTLS_PORT) },
    { secureTransport: "off" },
  )
  scope.socket = raw
  raw.closed.catch(() => {})
  await raw.opened
  scope.stage = "node_tls"
  const reader = raw.readable.getReader(),
    writer = raw.writable.getWriter()
  let rawWrites = Promise.resolve()
  const writeRaw = (data) => {
    rawWrites = rawWrites.then(() => {
      scope.touch()
      return writer.write(data)
    })
    rawWrites.catch(() => {})
    return rawWrites
  }
  const outer = await wrapTls(
    env.ANYTLS_SNI || env.ANYTLS_SERVER,
    {
      async read() {
        const { done, value } = await reader.read()
        return done ? undefined : value
      },
      write: writeRaw,
    },
    scope,
    {
      verify: env.ANYTLS_INSECURE !== "true",
      alpn: JSON.parse(env.ANYTLS_ALPN || '["h2","http/1.1"]'),
    },
  )
  const scheme = cachedPadding
  const padding0 = scheme.rules.get(0)?.[0]
  const paddingLength = padding0 && padding0 !== "c" ? pick(padding0) : 0
  const padLength = new Uint8Array(2)
  new DataView(padLength.buffer).setUint16(0, paddingLength)
  const password = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encode(env.ANYTLS_PASSWORD)),
  )
  scope.stage = "anytls_auth"
  await outer.write(
    concat(
      password,
      padLength,
      crypto.getRandomValues(new Uint8Array(paddingLength)),
    ),
  )
  await rawWrites
  let packet = 1,
    writes = Promise.resolve()
  const send = (data) => {
    writes = writes.then(async () => {
      for (const part of padPacket(data, packet++, scheme))
        await outer.write(part)
      await rawWrites
    })
    writes.catch(() => {})
    return writes
  }
  const hostname = encode(target.hostname)
  const address = concat(
    new Uint8Array([3, hostname.length]),
    hostname,
    new Uint8Array([1, 187]),
  ) // port 443
  await send(
    concat(
      frame(
        4,
        0,
        encode(
          `v=2\nclient=openlist-anytls-gateway/1.0.0\npadding-md5=${scheme.md5}`,
        ),
      ),
      frame(1, 1),
      frame(2, 1, address),
    ),
  )
  const incoming = new ByteReader(() => outer.read())
  return {
    async read() {
      for (;;) {
        const head = await incoming.exact(7)
        if (!head) return undefined
        const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
        const command = head[0],
          id = view.getUint32(1),
          length = view.getUint16(5)
        const payload = length ? await incoming.exact(length) : new Uint8Array()
        if (!payload) throw new Error("truncated_anytls")
        if (command === 5) throw new Error("node_rejected_session")
        if (command === 7 && id === 1 && length)
          throw new Error("target_connection_rejected")
        if (command === 6) cachedPadding = parsePadding(decode(payload))
        if (command === 8) await send(frame(9, id))
        if (command === 2 && id === 1 && length) return payload
        if (command === 3 && id === 1) return undefined
      }
    },
    async write(data) {
      for (let offset = 0; offset < data.length; offset += 16000)
        await send(frame(2, 1, data.slice(offset, offset + 16000)))
    },
  }
}
