// Single-session diagnostic only; no pooling or production proxy integration.
import { connect } from 'cloudflare:sockets';
import { wrapTls } from './tls.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
};
function frame(cmd, stream, data = new Uint8Array()) {
  if (data.length > 65535) throw new Error('frame_too_large');
  const head = new Uint8Array(7);
  const view = new DataView(head.buffer);
  view.setUint8(0, cmd); view.setUint32(1, stream); view.setUint16(5, data.length);
  return concat(head, data);
}
class ByteReader {
  constructor(read) { this.next = read; this.buffer = new Uint8Array(); }
  async read(n) {
    while (this.buffer.length < n) {
      const data = await this.next();
      if (!data) {
        if (this.buffer.length) throw new Error('truncated_stream');
        return undefined;
      }
      this.buffer = concat(this.buffer, data);
      if (this.buffer.length > 1024 * 1024) throw new Error('receive_limit');
    }
    const result = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return result;
  }
}
async function openAnyTls(env, host, port, state) {
  state.stage = 'outer_tcp';
  const raw = connect({ hostname: env.ANYTLS_SERVER, port: Number(env.ANYTLS_PORT) }, { secureTransport: 'off' });
  raw.closed.catch(() => {});
  state.socket = raw;
  await raw.opened;
  state.stage = 'outer_tls';
  const writer = raw.writable.getWriter();
  const reader = raw.readable.getReader();
  const outer = await wrapTls(env.ANYTLS_SNI || env.ANYTLS_SERVER, {
    async read() { const { done, value } = await reader.read(); return done ? undefined : value; },
    write: data => writer.write(data),
  }, {
    verify: env.ANYTLS_INSECURE !== 'true',
    alpn: JSON.parse(env.ANYTLS_ALPN || '["h2","http/1.1"]'),
    onPacket: () => { state.outer_peer_responded = true; },
  });
  state.outer_tls_verified = env.ANYTLS_INSECURE !== 'true';
  state.outer_tls_version = outer.metadata.version;
  const incoming = new ByteReader(async () => {
    return outer.read();
  });
  let writes = Promise.resolve();
  const send = (data) => {
    writes = writes.then(() => outer.write(data));
    writes.catch(() => {});
    return writes;
  };
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(env.ANYTLS_PASSWORD)));
  // Protocol v2 authentication, default packet-0 padding, settings and one stream.
  const padding = crypto.getRandomValues(new Uint8Array(30));
  state.stage = 'anytls_auth';
  await send(concat(hash, new Uint8Array([0, 30]), padding));
  const domain = enc.encode(host);
  const address = concat(new Uint8Array([3, domain.length]), domain, new Uint8Array([port >> 8, port & 255]));
  await send(concat(
    frame(4, 0, enc.encode('v=2\nclient=openlist-worker-diagnostic\npadding-md5=\n')),
    frame(1, 1), frame(2, 1, address), frame(0, 0, new Uint8Array(100)),
  ));
  const readPayload = async () => {
    for (;;) {
      const head = await incoming.read(7);
      if (!head) return undefined;
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      const cmd = head[0], id = view.getUint32(1), length = view.getUint16(5);
      const data = length ? await incoming.read(length) : new Uint8Array();
      if (!data) throw new Error('truncated_frame');
      if (cmd === 5) throw new Error('anytls_server_alert');
      if (cmd === 7 && id === 1) {
        if (length) throw new Error('anytls_target_rejected');
        state.anytls_ack = true;
      }
      if (cmd === 8) await send(frame(9, id, data));
      if (cmd === 2 && id === 1) return data;
      if (cmd === 3 && id === 1) return undefined;
    }
  };
  return {
    read: readPayload,
    write(data) {
      for (let offset = 0; offset < data.length; offset += 16000) send(frame(2, 1, data.slice(offset, offset + 16000)));
      return writes;
    },
    flush: () => writes,
  };
}
function parseResponse(raw) {
  let split = -1;
  for (let i = 0; i + 3 < raw.length; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) { split = i; break; }
  }
  if (split < 0) throw new Error('invalid_http_response');
  const header = dec.decode(raw.slice(0, split)), lines = header.split('\r\n');
  const status = Number(lines[0].split(' ')[1]);
  let body = raw.slice(split + 4);
  if (/\r\ntransfer-encoding:\s*chunked/i.test(header)) {
    let result = new Uint8Array();
    for (;;) {
      let end = -1;
      for (let i = 0; i + 1 < body.length; i++) if (body[i] === 13 && body[i + 1] === 10) { end = i; break; }
      if (end < 0) throw new Error('truncated_chunk');
      const n = parseInt(dec.decode(body.slice(0, end)).split(';')[0], 16);
      if (!Number.isFinite(n)) throw new Error('invalid_chunk');
      body = body.slice(end + 2);
      if (!n) { body = result; break; }
      if (body.length < n + 2) throw new Error('truncated_chunk');
      if (body[n] !== 13 || body[n + 1] !== 10) throw new Error('invalid_chunk_end');
      result = concat(result, body.slice(0, n)); body = body.slice(n + 2);
    }
  }
  return { status, body: dec.decode(body) };
}
async function request(env, host, path, form, state) {
  if (state.use_direct) {
    state.stage = 'direct_https';
    const r = await fetch(`https://${host}${path}`, {
      method: form ? 'POST' : 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Authorization': `Bearer ${env.PAN115_ACCESS_TOKEN}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form ? new URLSearchParams(form) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    return { status: r.status, body: await r.text() };
  }
  const tunnel = await openAnyTls(env, host, 443, state);
  state.stage = 'inner_tls';
  const tls = await wrapTls(host, tunnel);
  state.inner_tls_verified = true;
  const body = form ? new URLSearchParams(form).toString() : '';
  const headers = [
    `${form ? 'POST' : 'GET'} ${path} HTTP/1.1`, `Host: ${host}`,
    'User-Agent: Mozilla/5.0', 'Accept-Encoding: identity', 'Connection: close',
  ];
  if (form) headers.push(`Authorization: Bearer ${env.PAN115_ACCESS_TOKEN}`,
    'Content-Type: application/x-www-form-urlencoded', `Content-Length: ${enc.encode(body).length}`);
  state.stage = 'https_response';
  await tls.write(enc.encode(headers.join('\r\n') + '\r\n\r\n' + body));
  await tunnel.flush();
  let response = new Uint8Array();
  for (;;) {
    const data = await tls.read();
    if (!data) break;
    response = concat(response, data);
    if (response.length > 512 * 1024) throw new Error('response_limit');
  }
  return parseResponse(response);
}
export default {
  async fetch(req, env) {
    if (!env.TEST_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.TEST_TOKEN}`) return new Response('Unauthorized', { status: 401 });
    const path = new URL(req.url).pathname;
    if (!['/trace', '/115', '/115-direct'].includes(path)) return new Response('Not found', { status: 404 });
    if (path.startsWith('/115') && (req.method !== 'POST' || !env.PAN115_ACCESS_TOKEN)) return new Response('115 test unavailable', { status: 400 });
    const state = { stage: 'init', use_direct: path === '/115-direct' };
    const started = Date.now();
    let timer;
    try {
      const run = async () => {
        if (path === '/trace') {
          const response = await request(env, 'www.cloudflare.com', '/cdn-cgi/trace', undefined, state);
          const trace = Object.fromEntries(response.body.trim().split('\n').map(l => l.split('=')));
          return { http_status: response.status, exit_ip: trace.ip, exit_country: trace.loc, target_colo: trace.colo };
        }
        const info = await request(env, 'proapi.115.com', '/open/folder/get_info', { path: '/media/script/converted_tree.txt' }, state);
        const infoJson = JSON.parse(info.body);
        const step = { http_status: info.status, state: infoJson.state, code: infoJson.code };
        if (!infoJson.state) return { get_info: step };
        if (state.socket) await state.socket.close();
        const pickCode = infoJson.data?.pick_code;
        if (!pickCode) throw new Error('missing_pick_code');
        const down = await request(env, 'proapi.115.com', '/open/ufile/downurl', { pick_code: pickCode }, state);
        const downJson = JSON.parse(down.body);
        const hasDownloadUrl = Object.values(downJson.data || {}).some(entry => typeof entry?.url?.url === 'string' && entry.url.url.length > 0);
        return { get_info: step, downurl: { http_status: down.status, state: downJson.state, code: downJson.code, has_download_url: hasDownloadUrl } };
      };
      const result = await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 25000); })]);
      return Response.json({ ok: true, transport: state.use_direct ? 'cf-fetch' : 'anytls', ...result, anytls_ack: !!state.anytls_ack, outer_tls_verified: state.outer_tls_verified, outer_tls_version: state.outer_tls_version, inner_tls_verified: !!state.inner_tls_verified, elapsed_ms: Date.now() - started });
    } catch (e) {
      // Scrub values from errors; never return remote node addresses or credentials.
      let error = String(e.message || 'test_failed');
      for (const key of ['ANYTLS_SERVER', 'ANYTLS_SNI', 'ANYTLS_PASSWORD', 'PAN115_ACCESS_TOKEN', 'TEST_TOKEN']) if (env[key]) error = error.split(env[key]).join('[redacted]');
      return Response.json({ ok: false, stage: state.stage, error: error.slice(0, 240), outer_peer_responded: !!state.outer_peer_responded, outer_tls_verified: state.outer_tls_verified, outer_tls_version: state.outer_tls_version, anytls_ack: !!state.anytls_ack, inner_tls_verified: !!state.inner_tls_verified, elapsed_ms: Date.now() - started }, { status: 502 });
    } finally {
      clearTimeout(timer);
      if (state.socket) await state.socket.close().catch(() => {});
    }
  },
};
