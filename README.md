# ppv-st-addon

Stremio addon that lists live events from [ppv.st](https://ppv.st) as a catalog and plays them through a local HLS proxy (`/p`), which adds the headers the site's CDN requires and unwraps the WebP-wrapped TS segments. See `BRIEF.md` for the recon notes.

## Run

    npm install
    npm start            # http://127.0.0.1:7000
    npm test

Open `/` for the landing page with install links; `/healthz` for status.

## Install in Stremio

- App: open `stremio://<host>/manifest.json`
- Web: `https://web.stremio.com/#/addons?addon=<url-encoded https://<host>/manifest.json>`
- Or paste `http://127.0.0.1:7000/manifest.json` into the addon search box.

Stremio fetches streams itself, so the addon must be reachable from the device. For remote use, put it behind an HTTPS tunnel (Cloudflare Tunnel, ngrok, ...). Stremio Web requires HTTPS for non-localhost addons.

## Env vars

| var | default | meaning |
|---|---|---|
| `PORT` | `7000` | listen port |
| `BASE_URL` | derived from request `Host` / `X-Forwarded-*` | public origin used in stream URLs |
| `STUB_RESOLVE` | unset | if set, resolver returns a fixed fake URL (smoke testing) |

## Known limitation

The resolver (`lib/resolve.js`) depends on the site's embed bridge (`taifood-blog.asia/fetch`, a protobuf endpoint). The wire format is reverse-engineered and may change; if it does, streams fail while the catalog keeps working. Without `lib/resolve.js` the server starts with a stub that throws `resolver not implemented`.
