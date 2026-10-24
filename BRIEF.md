# ppv.st → Stremio addon: recon brief (captured live from the site today)

Everything below was observed directly. Raw captures live in `test/` (last section).

## 1. Catalogue API (public, documented at https://ppv.st/api)

```
GET https://api.ppv.st/api/ping
    -> {success, domains:[ppv.st, ppv.tj, ppvs.pk, ppv.rw, ppv.ms, ppv.bi, ppv.ug], status:[...]}
GET https://api.ppv.st/api/streams
    -> {success, timestamp, READ_ME, performance, streams:[ {category, id, always_live, streams:[...]} ]}
GET https://api.ppv.st/api/streams/<uri_name>
    -> {success, data:{ id, name, poster, tag, source_tag, m3u8:"", source_type:"playlist",
                        sources:[{name:"External Player Frame", default:true, type:"iframe",
                                  data:"https://taifood-blog.asia/embed/<uri_name>"}],
                        substreams:[{id,name,tag,uri_name,source_tag,iframe}], start_timestamp, end_timestamp,
                        category, vip_stream, auth, server_id, uri, viewers }}
GET https://api.ppv.st/api/vods      (exists; VODs, not needed for the addon)
```

Stream object inside `/streams`: `id, name, tag, source_tag, poster, uri_name, starts_at, ends_at,
always_live (0/1), category_name, iframe, substreams[], viewers`.
Currently 13 categories / ~131 streams. Every `iframe` is `https://taifood-blog.asia/embed/<uri_name>`
(single host, no query string). `starts_at`/`ends_at` are unix seconds; 24/7 channels have
`always_live:1, starts_at:0`. Backup API base `https://api.ppv.cx/api` has the same shape.
Site page for a stream: `https://ppv.st/live/<uri_name>`.

## 2. How a stream becomes playable

1. GET `https://taifood-blog.asia/embed/<uri_name>` returns a static ~269 KB HTML page. Its first inline
   script contains an ad loader and a loader for `https://taifood-blog.asia/js/bundle-jw.js`
   (jwplayer + a SwarmCloud P2P wrapper + WASM). The m3u8 is NOT in the HTML.
2. The bundle POSTs protobuf to `https://taifood-blog.asia/fetch` (SwarmCloud-style native bridge: binary
   protobuf in, binary protobuf out). That response carries the playlist URL.
   Reverse-engineered wire format (proto2-style, little-endian):
   - outer request `{k: string, payload: bytes}`:
     field 1 (string) = `k`, field 2 (bytes) = inner request
   - inner request:
     field 1 (string) = ad domain, field 2 (string) = ad `selPath`, field 3 (string) = `adbVersion`,
     field 4 (string) = `adblockDomain` (empty unless in adblock mode),
     field 5 (string) = **the embed URL** (`https://taifood-blog.asia/embed/<uri_name>`)
   - constants, base64-encoded inside bundle-jw.js:
     `k` = value of `window['ZpQw9XkLmN8c3vR3']` in the embed page (a long base64-ish blob, currently the
     same for every stream), `selPath` = `/d3.php`, `adbVersion` = `3-cdn`, `adblockDomain` = the
     `cdnDomain` field of `window['x4G9Tq2Kw6R7v1Dy3P0B5N8Lc9M2zF']` (currently `vbcojhroxkoaf.online`).
   - the request is sent from origin `https://taifood-blog.asia`, so send `Referer`/`Origin` accordingly.
   - response protobuf: field 1 (varint) = `ret`; when `ret` == 0 the playlist URL is inside field 2 or
     field 3 (nested message: field 1 string) — decoder must also tolerate a raw string URL or JSON.
   STATUS: **unverified**. This is the one remaining unknown; confirm it empirically before building
   around it. If the protobuf guess is wrong, capture the exact request the browser sends (headless
   Chromium, request body bytes for two different streams) and generalise from the diff.
3. Playlist URL shape:
   `https://<host>.indianservers.st/secure/<32-char-key>/<start>/<end>/<source_tag_lowercase>/index.m3u8`
   (hosts rotate — vishnu, shiva, netanyahu seen; source tag e.g. `tsn4`). The `<start>/<end>` are the
   event's unix bounds. Master playlist has a single variant: `tracks-v1a1/mono.ts.m3u8` (h264 1280x720 + aac).
4. Fetching requirements: the m3u8 returns **403 unless BOTH a browser User-Agent and a Referer
   (`https://taifood-blog.asia/`) are sent**. Media segments are public and need no headers.
5. Segment quirk: each segment is an MPEG-TS payload wrapped in a minimal WebP container —
   `RIFF` + size + `WEBPVP8L` (13-byte 1x1 lossless chunk) + `EXIF` chunk header, then the raw TS.
   The first TS sync byte (0x47) sits at byte offset **42**; that byte is itself a 4-byte TS
   prefix (`0x47 PID/...`) so the aligned stream starts at `(42 + 4) % 188 = 46` and every 188 bytes from
   there is one packet. ffprobe on that stripped file reports h264 1280x720 + aac and decodes cleanly.
   Do not hardcode 84 — locate the first 0x47 that also has 0x47 at +188 and +376, then align.

## 3. Constraints for the addon

- Never buffer media in memory: pipe segments (1–1.5 MB each, manifests refresh every ~6 s).
- Playlist URLs and the `/fetch` response expire (event end). On a 403 from the m3u8, re-resolve once,
  then surface the failure to Stremio instead of hanging.
- Stremio addon protocol via `stremio-addon-sdk` (`addonBuilder`, `defineCatalogHandler`,
  `defineStreamHandler`, `defineManifest`, `serveHTTP`).
- Node 26, CommonJS, no build step, no TypeScript. `express` + `stremio-addon-sdk` are fine; any
  protobuf handling must be hand-rolled (no .proto toolchain).
- Stremio fetches stream URLs itself, so the addon must expose an HLS URL on its own origin.

## 4. Raw captures

- `test/sample_seg_raw.bin` — one real segment as downloaded (WebP wrapper + TS), 944,554 bytes.
- `test/sample_clean.ts` — same segment with the wrapper stripped, 944,508 bytes, ffprobe-clean.
Use these in unit tests instead of hitting the network.
