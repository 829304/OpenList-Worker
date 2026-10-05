import { ByteReader, concat, encode } from "./bytes.js"

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])
const REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "authorization",
  "cookie",
  "content-type",
  "user-agent",
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
  "referer",
])
export const MAX_REQUEST_BYTES = 512 * 1024

export function validateRequest(
  input,
  allowedHosts,
  { keepAlive = false } = {},
) {
  if (
    !input ||
    typeof input.url !== "string" ||
    input.url.length > 16384 ||
    /[\x00-\x20\x7f]/.test(input.url)
  )
    throw new Error("invalid_target")
  const target = new URL(input.url)
  if (
    target.protocol !== "https:" ||
    (target.port && target.port !== "443") ||
    target.username ||
    target.password ||
    target.hash
  )
    throw new Error("invalid_target")
  const matches = allowedHosts
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .some((host) =>
      host.startsWith("*.")
        ? target.hostname.endsWith(host.slice(1))
        : target.hostname === host,
    )
  if (!matches) throw new Error("target_not_allowed")
  const method = input.method || "GET"
  if (!["GET", "POST", "HEAD"].includes(method))
    throw new Error("method_not_allowed")
  if (input.body != null && typeof input.body !== "string")
    throw new Error("invalid_body")
  const body = encode(input.body || "")
  if (body.length > MAX_REQUEST_BYTES || (method !== "POST" && body.length))
    throw new Error("invalid_body")
  if (!Array.isArray(input.headers) || input.headers.length > 32)
    throw new Error("invalid_headers")
  const headers = new Headers()
  for (const pair of input.headers) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some((value) => typeof value !== "string")
    )
      throw new Error("invalid_headers")
    const [key, value] = pair
    if (
      !/^[A-Za-z0-9-]+$/.test(key) ||
      /[\x00-\x1f\x7f]/.test(value) ||
      value.length > 16384
    )
      throw new Error("invalid_headers")
    // Host, length, compression and connection state are generated here.
    if (REQUEST_HEADERS.has(key.toLowerCase())) headers.append(key, value)
  }
  headers.set("host", target.hostname)
  headers.set("accept-encoding", "identity")
  headers.set("connection", keepAlive ? "keep-alive" : "close")
  if (method === "POST") headers.set("content-length", String(body.length))
  const lines = [`${method} ${target.pathname}${target.search} HTTP/1.1`]
  for (const [key, value] of headers) lines.push(`${key}: ${value}`)
  return {
    target,
    method,
    bytes: concat(encode(lines.join("\r\n") + "\r\n\r\n"), body),
  }
}

export async function readHttpResponse(transport, method, scope) {
  const reader = new ByteReader(() => transport.read())
  let status, headers, rawHeaders, http11
  let totalHeaders = 0
  for (let interim = 0; ; interim++) {
    const line = await reader.line()
    totalHeaders += line.length
    const match = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: .*|)$/.exec(line)
    if (!match) throw new Error("invalid_http_status")
    http11 = line.startsWith("HTTP/1.1 ")
    status = Number(match[1])
    headers = new Headers()
    rawHeaders = new Map()
    for (;;) {
      const line = await reader.line()
      totalHeaders += line.length + 2
      if (totalHeaders > 65536) throw new Error("header_limit")
      if (!line) break
      const colon = line.indexOf(":")
      if (colon <= 0 || !/^[A-Za-z0-9-]+$/.test(line.slice(0, colon)))
        throw new Error("invalid_http_headers")
      const name = line.slice(0, colon).toLowerCase(),
        value = line.slice(colon + 1).trim()
      if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("invalid_http_headers")
      rawHeaders.set(name, [...(rawHeaders.get(name) || []), value])
      headers.append(name, value)
    }
    if (status >= 200) break
    if (status === 101 || interim >= 4)
      throw new Error("unsupported_http_upgrade")
  }
  const lengths = (rawHeaders.get("content-length") || []).flatMap((value) =>
    value.split(",").map((v) => v.trim()),
  )
  if (lengths.some((value) => !/^\d+$/.test(value) || value !== lengths[0]))
    throw new Error("invalid_content_length")
  const length = lengths.length ? Number(lengths[0]) : undefined
  if (length !== undefined && !Number.isSafeInteger(length))
    throw new Error("invalid_content_length")
  const transfer = headers.get("transfer-encoding")?.toLowerCase()
  if (transfer && (transfer !== "chunked" || lengths.length))
    throw new Error("invalid_transfer_encoding")
  const persistent =
    http11 &&
    !/(^|,)\s*close\s*(,|$)/i.test(headers.get("connection") || "") &&
    (length !== undefined ||
      transfer === "chunked" ||
      method === "HEAD" ||
      status === 204 ||
      status === 304)
  const complete = async () => {
    if (persistent && !reader.buffer.length && scope.complete)
      await scope.complete()
    else await scope.close()
  }
  const remove = [
    ...HOP_HEADERS,
    ...(headers.get("connection") || "")
      .split(",")
      .map((v) => v.trim().toLowerCase()),
  ]
  for (const name of remove) if (name) headers.delete(name)
  for (const name of [...headers.keys()])
    if (name.startsWith("x-openlist-gateway-")) headers.delete(name)
  if (method === "HEAD") {
    // The outer gateway call is POST: do not claim a body length that it will not send.
    if (length !== undefined)
      headers.set("x-openlist-gateway-head-length", String(length))
    headers.delete("content-length")
  }
  if (method === "HEAD" || status === 204 || status === 304 || length === 0) {
    await complete()
    return { status, headers, body: null }
  }
  scope.streaming()
  let remaining = length,
    chunkRemaining = 0,
    trailersSize = 0
  let stopped = false
  const stop = async (success = false) => {
    if (!stopped) {
      stopped = true
      if (success) await complete()
      else await scope.close()
    }
  }
  const body = new ReadableStream({
    async pull(controller) {
      if (stopped) return
      try {
        if (transfer === "chunked") {
          if (!chunkRemaining) {
            const line = await reader.line(4096)
            const match = /^([0-9a-fA-F]+)(?:;[^\r\n]*)?$/.exec(line)
            if (!match) throw new Error("invalid_chunk")
            chunkRemaining = parseInt(match[1], 16)
            if (!Number.isSafeInteger(chunkRemaining))
              throw new Error("invalid_chunk")
            if (!chunkRemaining) {
              for (;;) {
                const trailer = await reader.line()
                trailersSize += trailer.length + 2
                if (trailersSize > 65536) throw new Error("header_limit")
                if (!trailer) break
              }
              if (!stopped) {
                controller.close()
                await stop(true)
              }
              return
            }
          }
          const data = await reader.part(Math.min(chunkRemaining, 16384))
          if (stopped) return
          if (!data) throw new Error("truncated_chunk")
          chunkRemaining -= data.length
          if (!chunkRemaining) {
            const end = await reader.exact(2)
            if (stopped) return
            if (!end || end[0] !== 13 || end[1] !== 10)
              throw new Error("invalid_chunk_end")
          }
          controller.enqueue(data)
        } else {
          const data = await reader.part(Math.min(remaining ?? 16384, 16384))
          if (stopped) return
          if (!data) {
            if (remaining) throw new Error("truncated_body")
            controller.close()
            await stop(true)
            return
          }
          if (remaining !== undefined) remaining -= data.length
          controller.enqueue(data)
          if (remaining === 0) {
            controller.close()
            await stop(true)
          }
        }
      } catch (error) {
        if (!stopped) controller.error(error)
        await stop()
      }
    },
    cancel: () => stop(),
  })
  return { status, headers, body }
}
