// resolve ppv.st HLS url w/o browser: node resolve.mjs <uri_name>
// the player's /fetch protocol is done by gasm.wasm (protobuf + chacha20 + custom b91); we run the site's own wasm in node w/ DOM stubs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
const HOST = 'https://taifood-blog.asia';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: HOST + '/' };
let wasmMod; // cached {mod, bytes}

async function loadWasm(log) {
  if (wasmMod) return wasmMod;
  const [js, wasm] = await Promise.all([`${HOST}/js/wasm/gasm.js`, `${HOST}/js/wasm/gasm.wasm`].map(async (u) => {
    const r = await fetch(u, { headers: H }); if (!r.ok) throw new Error(`${u} -> ${r.status}`); return Buffer.from(await r.arrayBuffer());
  }));
  const f = path.join(os.tmpdir(), `ppv-gasm-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(f, js);
  try { wasmMod = { mod: await import('file://' + f), wasm }; } finally { fs.rmSync(f, { force: true }); }
  log && log('gasm loaded', js.length, wasm.length);
  return wasmMod;
}

// minimal browser env the wasm touches; guarded so we only install once
let envDone = false;
function installEnv() {
  if (envDone) return; envDone = true;
  class Window {} class Document {}
  Object.setPrototypeOf(globalThis, Window.prototype);
  const el = () => ({ style: {}, setAttribute() {}, appendChild: (c) => c, remove() {}, addEventListener() {}, set textContent(v) {} });
  Object.assign(globalThis, { Window, Document, window: globalThis, screen: { width: 1920, height: 1080, colorDepth: 24, pixelDepth: 24 } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: UA, platform: 'Linux x86_64', hardwareConcurrency: 8, language: 'en-US', languages: ['en-US'], deviceMemory: 8, maxTouchPoints: 0 } });
  globalThis.P2PEngineHls = globalThis.P2pEngineHls = class { static tryRegisterServiceWorker() { return Promise.resolve(); } };
  const RR = Request;
  globalThis.Request = class extends RR { constructor(u, o) { super(String(u).startsWith('/') ? HOST + u : u, o); } }; // wasm uses relative /fetch
  const realFetch = fetch;
  globalThis.fetch = (a, o) => { // add the headers a browser would (origin/referer/UA); only for the site's own /fetch
    const u = String(a.url || a);
    if (u.startsWith(HOST + '/fetch')) { const r = new RR(a, o); for (const [k, v] of Object.entries({ ...H, Origin: HOST })) r.headers.set(k, v); return realFetch(r); }
    return realFetch(a, o);
  };
}

// uri_name -> master m3u8 url
async function resolve(uri, log = () => {}) {
  installEnv();
  const { mod, wasm } = await loadWasm(log);
  globalThis.location = { protocol: 'https:', host: 'taifood-blog.asia', hostname: 'taifood-blog.asia', origin: HOST, pathname: '/embed/' + uri, href: HOST + '/embed/' + uri, hash: '' };
  globalThis.document = Object.assign(new globalThis.Document(), { defaultView: globalThis, body: {}, head: {}, createElement: el0, querySelector: el0, getElementById: el0, location: globalThis.location, referrer: '' });
  function el0() { return { style: {}, setAttribute() {}, appendChild: (c) => c, remove() {}, addEventListener() {}, set textContent(v) {} }; }
  let got, resolveCfg;
  const p = new Promise((r) => (resolveCfg = r));
  globalThis.jwplayer = () => { const pl = { setup(c) { got = c; resolveCfg(c); return pl; }, on: () => pl, getConfig: () => ({}), load() {}, play() {}, stop() {}, getState: () => 'idle' }; return pl; };
  if (!wasmMod.inited) { await mod.default({ module_or_path: wasm }); wasmMod.inited = true; }
  try { await mod.set_stream_jw(uri); } catch (e) { log('set_stream_jw threw', String(e)); }
  const cfg = await Promise.race([p, new Promise((r) => setTimeout(r, 8000))]);
  if (!cfg || !cfg.file) throw new Error('no playlist from /fetch (stream offline / uri wrong?)');
  return cfg.file;
}

// indianservers.st WAF 403s node/curl default TLS ClientHello even w/ right UA+Referer; python-ssl's cipher list passes (JA3 gate), so pin it
const CIPHERS = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES256-SHA384:ECDHE-RSA-AES256-SHA384:ECDHE-ECDSA-AES128-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-SHA256:DHE-RSA-AES128-SHA256';
const agent = new https.Agent({ ciphers: CIPHERS, keepAlive: true });
const get = (u) => new Promise((ok, no) => https.get(u, { headers: H, agent }, (res) => {
  const ch = []; res.on('data', (d) => ch.push(d)); res.on('end', () => { const b = Buffer.concat(ch); ok({ status: res.statusCode, buf: b, text: () => b.toString() }); });
}).on('error', no));
function stripWebp(b) { // first 0x47 with 0x47 at +188,+376
  for (let i = 0; i < Math.min(b.length - 376, 4096); i++) if (b[i] === 0x47 && b[i + 188] === 0x47 && b[i + 376] === 0x47) return b.subarray(i);
  return null;
}
async function prove(uri) {
  const m3u8 = await resolve(uri, console.log); console.log('MASTER', m3u8);
  const mr = await get(m3u8); console.log('master status', mr.status);
  const mt = mr.text();
  const vurl = new URL(mt.split('\n').find((l) => l && !l.startsWith('#')), m3u8).href; console.log('VARIANT', vurl);
  const vr = await get(vurl); console.log('variant status', vr.status); const vt = vr.text();
  const surl = new URL(vt.split('\n').find((l) => l && !l.startsWith('#')), vurl).href; console.log('SEGMENT', surl);
  const raw = (await get(surl)).buf;
  const ts = stripWebp(raw); if (!ts) throw new Error('no TS sync; head ' + raw.subarray(0, 64).toString('hex'));
  let ok = 0, n = 0; for (let i = 0; i < ts.length - 187; i += 188) { n++; if (ts[i] === 0x47) ok++; }
  console.log(`seg ${raw.length}B, TS starts @${raw.length - ts.length}, ${ok}/${n} sync bytes OK`);
  if (ok !== n) throw new Error('TS misaligned');
}
export { resolve, stripWebp, get, CIPHERS };
if (import.meta.url === `file://${process.argv[1]}`) prove(process.argv[2] || 'nfl-network').then(() => setTimeout(() => process.exit(0), 50), (e) => { console.error('FAIL', e); process.exit(1); });
