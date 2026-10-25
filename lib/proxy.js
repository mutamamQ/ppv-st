'use strict';
const express = require('express');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const REFERER = 'https://taifood-blog.asia/';
const CACHE_TTL_MS = 2000;
const SEG_EXTS = new Set(['ts', 'm4s', 'mp4', 'aac', 'm4a', 'm4v', 'mp3', 'webp', 'bin']);

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');

// Decode a b64url param into an http(s) URL string, or null if invalid.
function decodeUrl(b64) {
  if (!/^[A-Za-z0-9_-]+$/.test(b64 || '')) return null;
  try {
    const s = Buffer.from(b64, 'base64url').toString('utf8');
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return s; // exact original string, never re-encoded
  } catch {
    return null;
  }
}

function extOf(uri) {
  try {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(new URL(uri).pathname);
    if (m && SEG_EXTS.has(m[1].toLowerCase())) return m[1].toLowerCase();
  } catch { /* fall through */ }
  return 'ts';
}

function isPlaylistUri(uri) {
  try { return /\.m3u8?$/i.test(new URL(uri).pathname); } catch { return false; }
}

// Rewrite an m3u8 body. baseUrl = upstream playlist URL, prefix = /p/<uriName>.
function rewritePlaylist(text, baseUrl, prefix) {
  const abs = (u) => (/^https?:\/\//i.test(u) ? u : new URL(u, baseUrl).href);
  const lines = text.split(/\r?\n/);
  let nextIsVariant = false;
  return lines.map((line) => {
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
        nextIsVariant = line.startsWith('#EXT-X-STREAM-INF');
      }
      return line.replace(/URI="([^"]*)"/g, (all, uri) => {
        if (!uri || /^data:/i.test(uri)) return all;
        let a;
        try { a = abs(uri); } catch { return all; }
        let kind;
        if (/^#EXT-X-KEY|^#EXT-X-SESSION-KEY/.test(line)) kind = `k/${b64u(a)}`;
        else if (/^#EXT-X-MAP/.test(line)) kind = `s/${b64u(a)}.${extOf(a)}`;
        else if (isPlaylistUri(a)) kind = `v/${b64u(a)}.m3u8`;
        else kind = `s/${b64u(a)}.${extOf(a)}`;
        return `URI="${prefix}/${kind}"`;
      });
    }
    if (!line.trim()) return line;
    let a;
    try { a = abs(line.trim()); } catch { return line; }
    const isVariant = nextIsVariant || isPlaylistUri(a);
    nextIsVariant = false;
    return isVariant ? `${prefix}/v/${b64u(a)}.m3u8` : `${prefix}/s/${b64u(a)}.${extOf(a)}`;
  }).join('\n');
}

// Strip WebP/EXIF wrapper; returns the offset to start emitting from (-1 if no 188-byte sync run yet).
// Layout: 'RIFF' <4-byte size> 'WEBPVP8L' <13-byte 1x1 chunk> 'EXIF' <4-byte size> then the TS.
// Segments come in two shapes: TS straight at the first 0x47, or a 4-byte prefix then 0x47; so the
// emit point is 4 bytes past the run when the run is the first 0x47, 8 bytes past when it is prefixed.
function wrapperOffset(buf) {
  if (buf.length < 400) return -1;
  const wrapped = buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 32).includes('WEBPVP8L');
  if (!wrapped) return 0;
  for (let i = 4; i + 376 < buf.length; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return i + 4;
  }
  return -1;
}

const HEAD_BYTES = 512; // max bytes held back while locating the TS start

function createProxy({ resolvePlaylist, fetchImpl = fetch, playlistGet: playlistGetImpl = null } = {}) {
  const router = express.Router();
  const cache = new Map(); // upstream url -> { at, text }
  const masterUrls = new Map(); // uriName -> url

  const hdrs = () => ({ 'User-Agent': UA, Referer: REFERER });
  const playlistGet = playlistGetImpl || ((url) => fetchImpl(url, { headers: hdrs(), signal: AbortSignal.timeout(15000) }).then(async (r) => (r.ok
    ? { status: 200, text: () => r.text() }
    : { status: r.status, text: () => { r.body?.cancel?.().catch(() => {}); return ''; } })));
  async function getText(url) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { status: 200, text: hit.text };
    // indianservers.st 403s node's default TLS ClientHello, so playlists go through the resolver's pinned agent
    let status, text;
    if (/\.indianservers\.st\//.test(url)) {
      const r = await playlistGet(url);
      status = r.status; text = r.text();
    } else {
      const r = await fetchImpl(url, { headers: hdrs(), signal: AbortSignal.timeout(15000) });
      if (!r.ok) { r.body?.cancel?.().catch(() => {}); return { status: r.status }; }
      status = 200; text = await r.text();
    }
    if (status !== 200) return { status };
    cache.set(url, { at: Date.now(), text });
    if (cache.size > 200) for (const [k, v] of cache) if (Date.now() - v.at > CACHE_TTL_MS) cache.delete(k);
    return { status: 200, text };
  }

  // Fetch playlist text; on 403 re-resolve once (only possible for master / via fresh master).
  async function fetchWithRetry(uriName, url) {
    let r = await getText(url);
    if (r.status !== 403) return r;
    if (url === masterUrls.get(uriName)) {
      const fresh = await resolvePlaylist(uriName);
      masterUrls.set(uriName, fresh);
      return { ...(await getText(fresh)), url: fresh };
    }
    // Variant URL expired: resolve fresh master, retry the same-named variant under the new base.
    const fresh = await resolvePlaylist(uriName);
    masterUrls.set(uriName, fresh);
    const old = new URL(url);
    const m = await getText(fresh);
    if (m.status !== 200) return m;
    const tail = old.pathname.split('/').slice(-2).join('/');
    const cand = m.text.split(/\r?\n/).find((l) => l && !l.startsWith('#') && l.includes(tail.split('/')[0]));
    const retryUrl = cand ? (/^https?:\/\//i.test(cand.trim()) ? cand.trim() : new URL(cand.trim(), fresh).href) : new URL(old.pathname.split('/').slice(-2).join('/'), fresh).href;
    return { ...(await getText(retryUrl)), url: retryUrl };
  }

  function sendPlaylist(res, text, baseUrl, prefix) {
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-cache');
    res.send(rewritePlaylist(text, baseUrl, prefix));
  }

  const fail = (res, e) => {
    if (!res.headersSent) res.status(502).type('text/plain').send(`upstream error: ${e && e.message ? e.message : e}`);
  };

  router.get(/^\/p\/(.+)\/master\.m3u8$/, async (req, res) => {
    const uriName = req.params[0];
    try {
      let url = masterUrls.get(uriName);
      if (!url) { url = await resolvePlaylist(uriName); masterUrls.set(uriName, url); }
      const r = await fetchWithRetry(uriName, url);
      if (r.status !== 200) return res.status(502).type('text/plain').send(`upstream returned ${r.status}`);
      sendPlaylist(res, r.text, r.url || masterUrls.get(uriName), `/p/${uriName}`);
    } catch (e) { fail(res, e); }
  });

  router.get(/^\/p\/(.+)\/v\/([^/]+)\.m3u8$/, async (req, res) => {
    const uriName = req.params[0];
    const url = decodeUrl(req.params[1]);
    if (!url) return res.status(400).type('text/plain').send('bad url');
    try {
      const r = await fetchWithRetry(uriName, url);
      if (r.status !== 200) return res.status(502).type('text/plain').send(`upstream returned ${r.status}`);
      sendPlaylist(res, r.text, r.url || url, `/p/${uriName}`);
    } catch (e) { fail(res, e); }
  });

  router.get(/^\/p\/(.+)\/k\/([^/.]+)$/, async (req, res) => {
    const url = decodeUrl(req.params[1]);
    if (!url) return res.status(400).type('text/plain').send('bad url');
    try {
      const r = await fetchImpl(url, { headers: hdrs(), signal: AbortSignal.timeout(15000) });
      if (!r.ok) return res.status(502).type('text/plain').send(`upstream returned ${r.status}`);
      res.set('Content-Type', 'application/octet-stream').send(Buffer.from(await r.arrayBuffer()));
    } catch (e) { fail(res, e); }
  });

  router.get(/^\/p\/(.+)\/s\/([^/.]+)\.([A-Za-z0-9]+)$/, async (req, res) => {
    const url = decodeUrl(req.params[1]);
    if (!url) return res.status(400).type('text/plain').send('bad url');
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const r = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
      if (!r.ok) {
        r.body?.cancel?.().catch(() => {});
        console.error(`[proxy] segment upstream ${r.status}: ${url.slice(0, 120)}`);
        return res.status(502).type('text/plain').send(`upstream returned ${r.status}`);
      }
      const ext = req.params[2].toLowerCase();
      res.set('Content-Type', ext === 'ts' ? 'video/mp2t' : (r.headers.get('content-type') || 'application/octet-stream'));
      res.removeHeader('Content-Length');

      // head buffer until a 188-byte sync run is found; emit from the run start (4 or 8 bytes past it
      // depending on whether the segment carries the 4-byte prefix before the first 0x47).
      let head = [], headLen = 0, skip = 0, runAt = -1;
      const write = (chunk) => (res.write(chunk) ? null : new Promise((ok) => {
        const done = () => { res.off('drain', done); res.off('close', done); ok(); };
        res.on('drain', done); res.on('close', done);
      }));
      for await (const chunk of r.body) {
        if (res.destroyed) break;
        if (runAt >= 0) { await write(chunk); continue; }
        head.push(chunk); headLen += chunk.length;
        const buf = Buffer.concat(head);
        runAt = wrapperOffset(buf);
        if (runAt < 0 && headLen < 16384) continue; // keep buffering until the run shows up
        head = []; headLen = 0;
        if (runAt < 0) { runAt = 0; skip = 0; await write(buf); continue; }
        skip = runAt;
        await write(buf.subarray(skip));
      }
      if (runAt < 0 && !res.destroyed) res.write(Buffer.concat(head));
      res.end();
    } catch (e) {
      if (ac.signal.aborted) return;
      if (res.headersSent) res.destroy(); else fail(res, e);
    }
  });

  return router;
}

module.exports = { createProxy, rewritePlaylist, wrapperOffset, decodeUrl, UA, REFERER };
