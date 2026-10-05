import { makeTLSClient, setCryptoImplementation } from "@reclaimprotocol/tls"
import { webcryptoCrypto } from "@reclaimprotocol/tls/webcrypto"
import { AsyncQueue, concat } from "./bytes.js"

setCryptoImplementation(webcryptoCrypto)
const silent = Object.fromEntries(
  ["trace", "debug", "info", "warn", "error"].map((key) => [key, () => {}]),
)

export async function wrapTls(
  host,
  transport,
  scope,
  { verify = true, alpn = ["http/1.1"] } = {},
) {
  const queue = new AsyncQueue()
  let resolveHandshake, rejectHandshake
  const handshake = new Promise((resolve, reject) => {
    resolveHandshake = resolve
    rejectHandshake = reject
  })
  handshake.catch(() => {})
  const finish = (error) => {
    queue.finish(error)
    rejectHandshake(error || new Error("tls_peer_closed"))
  }
  const abort = () => finish(new Error("request_cancelled"))
  scope.signal.addEventListener("abort", abort, { once: true })
  let certificateStarted
  const certificateMetric =
    scope.stage === "node_tls" ? "node_cert_verify" : "target_cert_verify"
  const tls = makeTLSClient({
    host,
    verifyServerCertificate: verify,
    applicationLayerProtocols: alpn,
    namedCurves: ["SECP256R1"],
    cipherSuites: [
      "TLS_AES_128_GCM_SHA256",
      "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
      "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
    ],
    logger: {
      ...silent,
      trace: (...args) => {
        if (args.at(-1) === "received certificate")
          certificateStarted = Date.now()
      },
      debug: (...args) => {
        if (
          args.at(-1) === "verified certificate chain" &&
          certificateStarted !== undefined
        )
          scope.timings?.push([
            certificateMetric,
            Date.now() - certificateStarted,
          ])
      },
    },
    write: ({ header, content }) => transport.write(concat(header, content)),
    onHandshake: resolveHandshake,
    onApplicationData: (data) => queue.push(data.slice()),
    onTlsEnd: finish,
  })
  const pump = async () => {
    try {
      while (!queue.done && !scope.signal.aborted) {
        await queue.capacity()
        if (queue.done || scope.signal.aborted) break
        const data = await transport.read()
        if (!data) {
          finish(
            tls.isHandshakeDone() ? undefined : new Error("tls_peer_closed"),
          )
          break
        }
        scope.touch()
        await tls.handleReceivedBytes(data)
      }
    } catch (error) {
      finish(error)
    } finally {
      scope.signal.removeEventListener("abort", abort)
    }
  }
  pump()
  try {
    await tls.startHandshake()
    await handshake
  } catch (error) {
    finish(error)
    throw error
  }
  return {
    read: () => queue.read(),
    write: (data) => tls.write(data),
    metadata: tls.getMetadata(),
    closed: () => queue.done || scope.signal.aborted,
  }
}
