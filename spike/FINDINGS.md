# ppv.st resolver findings

**Result: works end-to-end** (`node spike/resolve.mjs nfl-network`, also `cfb/2026-10-24/tenn-sc/skycast`):
resolved master m3u8 -> 200, variant `tracks-v1a1/mono.ts.m3u8` -> 200, first segment -> WebP wrapper stripped, TS starts @42, 100% of 188B packets begin with 0x47 (36896/36896, 18496/18496).

## /fetch is NOT plain protobuf (the BRIEF guess was wrong)
Every guess in the brief (protobuf k/inner, JSON, k-only) gets `404 Not Found` / `500`. The real protocol lives in
`https://taifood-blog.asia/js/wasm/gasm.js` + `gasm.wasm` (Rust/wasm-bindgen; prost + chacha20 + custom base91-ish alphabet + sha256).
`bundle-jw.js` only loads it (`set_stream_jw(uri_name)`); `window['ZpQw9XkLmN8c3vR3']` / `x4G9...` are for ads, not /fetch.

Observed wire (browser capture, `cap1.json`, `response.bin.hex`):
- Request: `POST /fetch`, `Content-Type: application/octet-stream`, header `indians: <sha256 hex>` (sha256 of a JSON browser-fingerprint string: tz, UA, screen, webgl...; server does not seem to enforce it — wrong/absent value still returns 200)
- Body (13B) = protobuf `{1: "<uri_name>"}` = `0a 0b "nfl-network"`
- Response: 200, gzip, `application/octet-stream`, header `island: EPSTEIN<25 random letters>` (CORS-exposed; rotates every call). Body = `0a ac 01 <172 printable-ASCII bytes> 12 04 "NFLN"` i.e. protobuf `{1: <172B obfuscated URL>, 2: "<channelId>"}`.
- The 172 bytes are the playlist URL encoded with a per-call scheme (keyed off `island`; not plain xor/base64/chacha-with-island, I brute-forced those). Decoding is inside wasm and I did NOT reimplement it.
- Plain URL was seen in wasm memory after the call, e.g. `https://shiva.indianservers.st/secure/<32>/0/1792962533/NFLN/index.m3u8`; wasm then calls `jwplayer().setup({file: url, ...})`.

## Working approach (pure Node, no npm)
Run the site's own wasm in Node with tiny DOM stubs and read `file` from the stubbed `jwplayer().setup()`:
1. fetch `gasm.js` (ES module, written to tmp .mjs and imported) and `gasm.wasm` with UA+Referer
2. stubs: `window/Window` (instanceof), `Document`, `location` (host taifood-blog.asia, pathname /embed/<uri>), `navigator.userAgent`, `P2PEngineHls.tryRegisterServiceWorker`, `Request` that resolves relative `/fetch`, `fetch` wrapper adding UA/Referer/Origin for `/fetch`
3. `await mod.default({module_or_path: wasmBytes}); mod.set_stream_jw(uri_name)` (throws an empty error at the end, harmless)
4. `jwplayer(...).setup(cfg)` receives `cfg.file` = m3u8 URL (hosts vary: vishnu/shiva/netanyahu; path tag derived by server)
No embed-page fetch is needed. uri_name works for substreams too (`cfb/2026-10-24/tenn-sc/skycast`). Offline/unknown uri -> no setup call -> resolve() rejects after 8s.
Needs UA + Referer for gasm/fetch (node fetch headers set in resolve.mjs). If gasm.js changes name/exports, adjust (`default`, `set_stream_jw`).

## Gotcha: indianservers.st blocks node/curl TLS fingerprint
With correct UA+Referer, `https://*.indianservers.st/...m3u8` returns **403 from node fetch/https and curl**, but **200 from Python ssl/http.client** and identical header bytes. Cause is the TLS ClientHello (cipher list), not headers/HTTP version/ALPN/curves: pinning Python's default cipher list in node (`https.Agent({ciphers: CIPHERS})`, exported as `CIPHERS` in resolve.mjs; order irrelevant, dropping or adding any one cipher gives 403) gives 200. The addon MUST fetch m3u8/variant via `https` with that agent, not global `fetch`. Segments (tiktokcdn.com URLs in the playlist) are public.
Also keep playlist/segment URLs byte-for-byte (signed `x-signature`); resolve.mjs uses `new URL(rel, base).href` for playlist-relative URLs only, and passes the absolute segment URL untouched.

## Exports
`import { resolve, get, CIPHERS, stripWebp } from './resolve.mjs'` — `resolve(uri)` -> master URL, `get(url)` -> `{status, buf, text()}`.
Note: resolve() mutates globalThis (stubs); fine for a server process, calls are sequential-safe only (set_stream_jw uses a shared jwplayer stub) — serialize concurrent resolves with a mutex/queue.
