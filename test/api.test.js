'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApi } = require('../lib/api');

const CATS = [
  { category: 'Football', id: 1, always_live: 0, streams: [
    { id: 10, name: 'A v B', tag: 't', source_tag: 'TSN4', poster: 'p', uri_name: 'foot/a-b', starts_at: 1, ends_at: 2,
      always_live: 0, category_name: 'Football', iframe: 'https://x/embed/foot/a-b', substreams: [], viewers: 5 } ] },
  { category: '24/7', id: 2, always_live: 1, streams: [
    { id: 20, name: 'Chan', uri_name: 'ch/1', always_live: 1, starts_at: 0, ends_at: 0 } ] },
];

let servers, counts, mode;
function start(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}`); });
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

// Good server: counts hits per path; behaviour switchable via `mode`.
const good = (req, res) => {
  counts[req.url] = (counts[req.url] || 0) + 1;
  if (mode === 'down') return json(res, 500, {});
  if (req.url === '/api/streams') return setTimeout(() => json(res, 200, { success: true, streams: CATS }), 30);
  if (req.url === '/api/streams/foot%2Fa-b') return json(res, 200, { success: true, data: { id: 10, uri: 'foot/a-b' } });
  json(res, 404, {});
};

const mk = (extra) => createApi({ retryDelayMs: 1, timeoutMs: 500, ...extra });

beforeEach(() => { servers = []; counts = {}; mode = 'ok'; });
afterEach(() => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))));

test('getStreams returns categories and caches for TTL', async () => {
  const base = await start(good);
  let t = 1000;
  const api = mk({ pingUrl: base + '/api/ping-none', fallbackBases: [base + '/api'], now: () => t });
  const a = await api.getStreams();
  assert.equal(a.length, 2);
  await api.getStreams();
  assert.equal(counts['/api/streams'], 1);
  t += 59_000; await api.getStreams();
  assert.equal(counts['/api/streams'], 1);
  t += 2_000; await api.getStreams();
  assert.equal(counts['/api/streams'], 2);
});

test('single-flight: concurrent callers share one request', async () => {
  const base = await start(good);
  const api = mk({ pingUrl: base + '/nope', fallbackBases: [base + '/api'] });
  const rs = await Promise.all([api.getStreams(), api.getStreams(), api.getStreams()]);
  assert.equal(counts['/api/streams'], 1);
  assert.strictEqual(rs[0], rs[1]);
});

test('stale-on-error: serves last good copy when refresh fails', async () => {
  const base = await start(good);
  let t = 0;
  const api = mk({ pingUrl: base + '/nope', fallbackBases: [base + '/api'], now: () => t });
  const first = await api.getStreams();
  mode = 'down'; t += 120_000;
  const second = await api.getStreams();
  assert.deepEqual(second, first);
  assert.ok(counts['/api/streams'] >= 2);
});

test('error propagates when no cache exists', async () => {
  const base = await start(good);
  mode = 'down';
  const api = mk({ pingUrl: base + '/nope', fallbackBases: [base + '/api'] });
  await assert.rejects(api.getStreams());
});

test('retries once on 5xx then succeeds', async () => {
  let n = 0;
  const base = await start((req, res) => {
    if (req.url !== '/api/streams') return json(res, 404, {});
    n++;
    if (n === 1) return json(res, 503, {});
    json(res, 200, { streams: CATS });
  });
  const api = mk({ pingUrl: base + '/nope', fallbackBases: [base + '/api'] });
  assert.equal((await api.getStreams()).length, 2);
  assert.equal(n, 2);
});

test('timeout aborts a hung request', async () => {
  const base = await start(() => {});
  const api = mk({ pingUrl: base + '/nope', fallbackBases: [base + '/api'], timeoutMs: 50 });
  const t0 = Date.now();
  await assert.rejects(api.getStreams());
  assert.ok(Date.now() - t0 < 2000);
});

test('domain fallback: first base dead, second works; ping failure uses fallback list', async () => {
  const dead = await start((req, res) => json(res, 500, {}));
  const live = await start(good);
  const api = mk({ pingUrl: dead + '/api/ping', fallbackBases: [dead + '/api', live + '/api'] });
  assert.equal((await api.getStreams()).length, 2);
});

test('ping domains are used, cached ~10 min, and fall back after them', async () => {
  const live = await start(good);
  let pings = 0;
  // ping server returns a domain that cannot resolve; fallback base is the live stub
  const pingSrv = await start((req, res) => { pings++; json(res, 200, { domains: ['invalid.invalid'] }); });
  let t = 0;
  const api = mk({ pingUrl: pingSrv + '/api/ping', fallbackBases: [live + '/api'], now: () => t, streamsTtlMs: 1 });
  await api.getStreams(); t += 10; await api.getStreams();
  assert.equal(pings, 1);
  t += 11 * 60_000; await api.getStreams();
  assert.equal(pings, 2);
});

test('getStream returns data; 404 is not retried across domains', async () => {
  const base = await start(good);
  const api = mk({ pingUrl: base + '/nope', fallbackBases: [base + '/api'] });
  assert.equal((await api.getStream('foot/a-b')).id, 10);
  await assert.rejects(api.getStream('missing'), /404/);
});

test('flatten merges categories with expected fields', async () => {
  const base = await start(good);
  const api = mk({ pingUrl: base + '/nope', fallbackBases: [base + '/api'] });
  const flat = await api.flatten();
  assert.equal(flat.length, 2);
  assert.deepEqual(Object.keys(flat[0]).sort(), ['always_live', 'category_name', 'ends_at', 'id', 'iframe', 'name',
    'poster', 'source_tag', 'starts_at', 'substreams', 'tag', 'uri_name', 'viewers']);
  assert.equal(flat[1].category_name, '24/7');
  assert.deepEqual(flat[1].substreams, []);
});
