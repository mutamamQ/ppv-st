# Proxy spec clarifications (from the orchestrator — read with BRIEF.md)

Additions to your task, verified against a second stream (a substream at 7.4 Mbps, 4.4 MB segments):

1. Master playlist shape confirmed on a second stream:
```
#EXTM3U
## IRON DOME
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=7400000,BANDWIDTH=9220000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2"
tracks-v1a1/mono.ts.m3u8
```
Note the bare comment line `## IRON DOME` — preserve all non-URI lines verbatim, only rewrite lines that
are URIs (lines not starting with `#`, and the URI part of `#EXT-X-MAP:`/`#EXT-X-KEY:`).

2. Segment sizes vary a lot (1 MB to 4.4 MB) — this is why nothing may be buffered: pipe with
`Readable.fromWeb(res.body).pipe(res)` (undici gives a web ReadableStream) and abort the upstream request
when the client disconnects (`req.on('close')` -> `ac.abort()`).

3. The wrapper strip must work on the stream, not the whole buffer: read the first 512 bytes, find the
TS start offset there, then emit those bytes from the offset onward plus the rest of the stream unchanged.
Use a transform that holds back at most 512 bytes. A segment whose first 512 bytes contain no valid
0x47 alignment is passed through untouched (some sources may be plain TS).

4. When a segment URL 404s or 403s (expired `x-expires` on the TikTok CDN host), respond 502 immediately
and log one line with the upstream status — do not retry segments.

5. The b64url path segment must be decode-safe: base64url only (`A-Za-z0-9_-`), decoded URL must parse and
have protocol http: or https:, otherwise 400.
