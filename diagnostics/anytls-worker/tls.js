import { makeTLSClient, setCryptoImplementation } from '@reclaimprotocol/tls';
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto';
setCryptoImplementation(webcryptoCrypto);
const silent = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error'].map(k => [k, () => {}]));

// Adapt a custom byte stream to TLS; Workers' native TLS cannot wrap an AnyTLS stream.
export async function wrapTls(host, transport, { verify = true, alpn = ['http/1.1'], onPacket = () => {} } = {}) {
  let resolveHandshake, rejectHandshake, wake;
  let ended = false, failure;
  const pending = [];
  const handshake = new Promise((resolve, reject) => { resolveHandshake = resolve; rejectHandshake = reject; });
  handshake.catch(() => {});
  const finish = error => {
    ended = true; failure = error;
    if (error) rejectHandshake(error);
    else rejectHandshake(new Error('tls_closed_before_handshake'));
    if (wake) { wake(); wake = undefined; }
  };
  const tls = makeTLSClient({
    host, verifyServerCertificate: verify,
    applicationLayerProtocols: alpn,
    namedCurves: ['SECP256R1'],
    cipherSuites: ['TLS_AES_128_GCM_SHA256', 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256'],
    logger: silent,
    write: ({ header, content }) => transport.write(new Uint8Array([...header, ...content])),
    onHandshake: resolveHandshake,
    onApplicationData(data) { pending.push(data.slice()); if (wake) { wake(); wake = undefined; } },
    onTlsEnd: finish,
  });
  const pump = async () => {
    try {
      while (!ended) {
        const data = await transport.read();
        if (!data) { finish(tls.isHandshakeDone() ? undefined : new Error('tls_peer_closed')); break; }
        onPacket();
        await tls.handleReceivedBytes(data);
      }
    } catch (e) { finish(e); }
  };
  pump();
  await tls.startHandshake();
  await handshake;
  return {
    metadata: tls.getMetadata(),
    write: data => tls.write(data),
    async read() {
      while (!pending.length && !ended) await new Promise(resolve => { wake = resolve; });
      if (pending.length) return pending.shift();
      if (failure) throw failure;
      return undefined;
    },
  };
}
