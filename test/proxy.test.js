'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createProxy } = require('../lib/proxy');

const raw = fs.readFileSync(path.join(__dirname, 'sample_seg_raw.bin'));
const clean = fs.readFileSync(path.join(__dirname, 'sample_clean.ts'));
const b64u = (s) => Buffer.from(s).toString('base64url');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const get = async (url) => { const r = await fetch(url); return { status: r.status, r, buf: Buffer.from(await r.arrayBuffer()) }; };

async function setup() {
  const st = { masterHits: 0, resolves: 0, forbidFirst: false, segQuery: null };
  const up = http.createServer((req, res) => {
    if (req.url.endsWith('.m3u8') && (!/Chrome\/148/.test(req.headers['user-agent'] || '') || req.headers.referer !== 'https://taifood-blog.asia/')) {
      res.statusCode = 403; return res.end('no');
    }
    if (req.url.startsWith('/secure/k/index.m3u8')) {
      st.masterHits++;
      if (st.forbidFirst && st.masterHits === 1) { res.statusCode = 403; return res.end('expired'); }
      return res.end('#EXTM3U\n## IRON DOME\n#EXT-X-STREAM-INF:BANDWIDTH=9220000,RESOLUTION=1280x720\ntracks-v1a1/mono.ts.m3u8\n');
    }
    if (req.url.startsWith('/secure/k/tracks-v1a1/mono.ts.m3u8')) {
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6.0,\nseg1.ts\n#EXTINF:6.0,\nhttp://127.0.0.1:' + up.address().port + '/seg/a%2Fb.ts?x=%3D&y=1\n');
    }
    if (req.url.startsWith('/seg/')) { st.segQuery = req.url; res.setHeader('Content-Length', raw.length); return res.end(raw); }
    res.statusCode = 404; res.end();
  });
  const upPort = await listen(up);
  const app = express();
  app.use(createProxy({ resolvePlaylist: async () => { st.resolves++; return `http://127.0.0.1:${upPort}/secure/k/index.m3u8`; } }));
  const srv = http.createServer(app);
  const port = await listen(srv);
  return { st, upPort, base: `http://127.0.0.1:${port}`, close: () => { up.closeAllConnections(); srv.closeAllConnections(); up.close(); srv.close(); } };
}

test('master + variant rewriting', async () => {
  const t = await setup();
  try {
    const m = await get(`${t.base}/p/ev1/master.m3u8`);
    assert.strictEqual(m.status, 200);
    const vUrl = `http://127.0.0.1:${t.upPort}/secure/k/tracks-v1a1/mono.ts.m3u8`;
    assert.strictEqual(m.buf.toString(), `#EXTM3U\n## IRON DOME\n#EXT-X-STREAM-INF:BANDWIDTH=9220000,RESOLUTION=1280x720\n/p/ev1/v/${b64u(vUrl)}.m3u8\n`);

    const v = await get(`${t.base}/p/ev1/v/${b64u(vUrl)}.m3u8`);
    assert.strictEqual(v.status, 200);
    const seg1 = `http://127.0.0.1:${t.upPort}/secure/k/tracks-v1a1/seg1.ts`;
    const seg2 = `http://127.0.0.1:${t.upPort}/seg/a%2Fb.ts?x=%3D&y=1`;
    const key = `http://127.0.0.1:${t.upPort}/secure/k/tracks-v1a1/key.bin`;
    assert.strictEqual(v.buf.toString(), `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-KEY:METHOD=AES-128,URI="/p/ev1/k/${b64u(key)}"\n#EXTINF:6.0,\n/p/ev1/s/${b64u(seg1)}.ts\n#EXTINF:6.0,\n/p/ev1/s/${b64u(seg2)}.ts\n`);
  } finally { t.close(); }
});

test('segment is stripped byte-for-byte, exact URL encoding kept', async () => {
  const t = await setup();
  try {
    const seg = `http://127.0.0.1:${t.upPort}/seg/a%2Fb.ts?x=%3D&y=1`;
    const s = await get(`${t.base}/p/ev1/s/${b64u(seg)}.ts`);
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.r.headers.get('content-type'), 'video/mp2t');
    assert.ok(s.buf.equals(clean), `got ${s.buf.length} bytes, want ${clean.length}`);
    assert.strictEqual(t.st.segQuery, '/seg/a%2Fb.ts?x=%3D&y=1');
  } finally { t.close(); }
});

test('403 on first manifest fetch triggers one re-resolve', async () => {
  const t = await setup();
  t.st.forbidFirst = true;
  try {
    const m = await get(`${t.base}/p/ev2/master.m3u8`);
    assert.strictEqual(m.status, 200);
    assert.match(m.buf.toString(), /#EXT-X-STREAM-INF/);
    assert.strictEqual(t.st.resolves, 2);
  } finally { t.close(); }
});

test('upstream failure returns 502', async () => {
  const t = await setup();
  try {
    const bad = `http://127.0.0.1:${t.upPort}/nope/x.m3u8`;
    assert.strictEqual((await get(`${t.base}/p/ev1/v/${b64u(bad)}.m3u8`)).status, 502);
    const badSeg = `http://127.0.0.1:${t.upPort}/nope/x.ts`;
    assert.strictEqual((await get(`${t.base}/p/ev1/s/${b64u(badSeg)}.ts`)).status, 502);
  } finally { t.close(); }
});

test('non-http scheme and bad base64 rejected with 400', async () => {
  const t = await setup();
  try {
    for (const u of ['file:///etc/passwd', 'ftp://x/y.ts']) {
      assert.strictEqual((await get(`${t.base}/p/ev1/s/${b64u(u)}.ts`)).status, 400);
      assert.strictEqual((await get(`${t.base}/p/ev1/v/${b64u(u)}.m3u8`)).status, 400);
    }
    assert.strictEqual((await get(`${t.base}/p/ev1/s/${'!!!'}.ts`)).status, 400);
  } finally { t.close(); }
});
