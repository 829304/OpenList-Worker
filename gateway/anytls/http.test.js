import assert from "node:assert/strict"
import { test } from "node:test"
import { encode } from "./bytes.js"
import { readHttpResponse, validateRequest } from "./http.js"
import { createGateway } from "./handler.js"

const hosts = "proapi.115.com,passportapi.115.com,*.115cdn.net"
function transport(text, split = 3) {
  const bytes = typeof text === "string" ? encode(text) : text
  let offset = 0
  return {
    async read() {
      if (offset === bytes.length) return undefined
      const part = bytes.slice(offset, offset + split)
      offset += part.length
      return part
    },
  }
}
function scope() {
  return {
    closed: 0,
    streaming() {},
    async close() {
      this.closed++
    },
  }
}

test("rejects forbidden origins, credentials, schemes, ports and request injection", () => {
  for (const url of [
    "https://evil115cdn.net/x",
    "https://proapi.115.com.evil.test/",
    "https://127.0.0.1/",
    "http://proapi.115.com/",
    "https://proapi.115.com:8443/",
    "https://u:p@proapi.115.com/",
    "https://proapi.115.com/#x",
  ]) {
    assert.throws(() => validateRequest({ url, headers: [] }, hosts))
  }
  assert.throws(() =>
    validateRequest(
      {
        url: "https://proapi.115.com/",
        headers: [["User-Agent", "ok\r\nAuthorization: steal"]],
      },
      hosts,
    ),
  )
  const input = validateRequest(
    {
      url: "https://a.115cdn.net/file",
      headers: [
        ["Host", "evil"],
        ["Authorization", "Bearer user-token"],
        ["Proxy-Authorization", "secret"],
        ["Range", "bytes=0-31"],
      ],
      method: "GET",
    },
    hosts,
  )
  const wire = new TextDecoder().decode(input.bytes)
  assert.match(wire, /host: a\.115cdn\.net/)
  assert.match(wire, /range: bytes=0-31/)
  assert.doesNotMatch(wire, /evil|proxy-authorization/)
})
test("dechunks byte lengths across fragmented UTF-8 and preserves independent cookies", async () => {
  const upstream =
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close, X-Secret\r\nX-Secret: remove\r\nSet-Cookie: A=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT\r\nSet-Cookie: B=2\r\n\r\n3\r\n中\r\n2\r\nok\r\n0\r\nX-Trailer: ignored\r\n\r\n"
  const lifecycle = scope()
  const response = await readHttpResponse(
    transport(upstream, 1),
    "GET",
    lifecycle,
  )
  assert.equal(await new Response(response.body).text(), "中ok")
  assert.equal(response.headers.getSetCookie().length, 2)
  assert.equal(response.headers.get("transfer-encoding"), null)
  assert.equal(response.headers.get("x-secret"), null)
  assert.equal(lifecycle.closed, 1)
})
test("rejects ambiguous HTTP framing and incomplete bodies", async () => {
  for (const headers of [
    "Content-Length: 2\r\nContent-Length: 3",
    "Content-Length: 2\r\nTransfer-Encoding: chunked",
    "Transfer-Encoding: gzip",
  ]) {
    await assert.rejects(
      readHttpResponse(
        transport(`HTTP/1.1 200 OK\r\n${headers}\r\n\r\nok`),
        "GET",
        scope(),
      ),
    )
  }
  const response = await readHttpResponse(
    transport("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nok"),
    "GET",
    scope(),
  )
  await assert.rejects(new Response(response.body).text(), /truncated_body/)
})
test("Range status and binary body survive; cancellation closes the socket", async () => {
  const data = new Uint8Array([0, 128, 255, 13, 10])
  const prefix = encode(
    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-4/100\r\nContent-Length: 5\r\n\r\n",
  )
  const all = new Uint8Array(prefix.length + data.length)
  all.set(prefix)
  all.set(data, prefix.length)
  const response = await readHttpResponse(transport(all), "GET", scope())
  assert.equal(response.status, 206)
  assert.equal(response.headers.get("content-range"), "bytes 0-4/100")
  assert.deepEqual(
    new Uint8Array(await new Response(response.body).arrayBuffer()),
    data,
  )
  const lifecycle = scope()
  const large = await readHttpResponse(
    transport("HTTP/1.1 200 OK\r\n\r\nabcdef"),
    "GET",
    lifecycle,
  )
  await large.body.cancel()
  assert.equal(lifecycle.closed, 1)
})
test("HEAD and no-body responses close immediately without sending an outer body length", async () => {
  const response = await readHttpResponse(
    transport("HTTP/1.1 200 OK\r\nContent-Length: 50000000\r\n\r\n"),
    "HEAD",
    scope(),
  )
  assert.equal(response.body, null)
  assert.equal(response.headers.get("content-length"), null)
  assert.equal(
    response.headers.get("x-openlist-gateway-head-length"),
    "50000000",
  )
})
test("authentication and validation run before the node is contacted; credentials never enter errors", async () => {
  let calls = 0
  const gateway = createGateway({
    connect() {
      calls++
      throw new Error("node-password secret")
    },
  })
  const env = {
    GATEWAY_TOKEN: "random-gateway-token-32-characters",
    ANYTLS_SERVER: "node.test",
    ANYTLS_PORT: "443",
    ANYTLS_PASSWORD: "secret",
  }
  const request = (body, auth = true) =>
    new Request("https://gateway.test/v1/request", {
      method: "POST",
      headers: auth ? { Authorization: `Bearer ${env.GATEWAY_TOKEN}` } : {},
      body: JSON.stringify(body),
    })
  assert.equal(
    (
      await gateway.fetch(
        request({ url: "https://proapi.115.com/", headers: [] }, false),
        env,
      )
    ).status,
    401,
  )
  assert.equal(
    (
      await gateway.fetch(
        request({ url: "https://169.254.169.254/", headers: [] }),
        env,
      )
    ).status,
    400,
  )
  assert.equal(calls, 0)
  const failed = await gateway.fetch(
    request({ url: "https://proapi.115.com/", headers: [] }),
    env,
  )
  assert.equal(failed.status, 502)
  assert.equal(calls, 1)
  assert.doesNotMatch(await failed.text(), /node-password|secret/)
})

test("gateway identifies upstream HTTP errors separately from runtime errors", async () => {
  const gateway = createGateway({
    connect() {},
    async openTunnel() {
      return {}
    },
    async secure() {
      return {
        ...transport(
          "HTTP/1.1 503 Unavailable\r\nContent-Length: 2\r\nX-OpenList-Gateway-Upstream: spoof\r\n\r\n{}",
        ),
        metadata: {},
        async write() {},
      }
    },
  })
  const response = await gateway.fetch(
    new Request("https://gateway.test/v1/request", {
      method: "POST",
      headers: { Authorization: "Bearer random-gateway-token-32-characters" },
      body: JSON.stringify({ url: "https://proapi.115.com/", headers: [] }),
    }),
    {
      GATEWAY_TOKEN: "random-gateway-token-32-characters",
      ANYTLS_SERVER: "node.test",
      ANYTLS_PORT: "443",
      ANYTLS_PASSWORD: "secret",
    },
  )
  assert.equal(response.status, 503)
  assert.equal(response.headers.get("x-openlist-gateway-upstream"), "1")
  assert.equal(await response.text(), "{}")
})

test("TLS failure diagnostics contain a category but never certificate details or credentials", async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (value) => warnings.push(value)
  try {
    const gateway = createGateway({
      connect() {},
      async openTunnel() {
        return {}
      },
      async secure() {
        const error = new Error(
          "Certificate for sensitive-node-host has sensitive-password",
        )
        error.name = "sensitive-password"
        throw error
      },
    })
    const response = await gateway.fetch(
      new Request("https://gateway.test/v1/request", {
        method: "POST",
        headers: { Authorization: "Bearer random-gateway-token-32-characters" },
        body: JSON.stringify({ url: "https://proapi.115.com/", headers: [] }),
      }),
      {
        GATEWAY_TOKEN: "random-gateway-token-32-characters",
        ANYTLS_SERVER: "node.test",
        ANYTLS_PORT: "443",
        ANYTLS_PASSWORD: "sensitive-password",
      },
    )
    assert.equal(response.status, 502)
    const details = (await response.text()) + JSON.stringify(warnings)
    assert.match(details, /certificate_validation/)
    assert.doesNotMatch(details, /sensitive-password|sensitive-node-host/)
  } finally {
    console.warn = originalWarn
  }
})
