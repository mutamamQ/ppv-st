const test = require('node:test')
const assert = require('node:assert')
const { buildAddon, manifest } = require('../lib/addon')

const NOW = 1_000_000
const mk = (o) => ({ name: o.uri_name, tag: '', source_tag: 'src', poster: 'http://p/' + o.uri_name, always_live: 0, starts_at: 0, ends_at: 0, category_name: 'Football', viewers: 0, ...o })
const groups = [
  { category: 'Football', streams: [
    mk({ uri_name: 'live-low', name: 'Arsenal vs Chelsea', starts_at: NOW - 100, ends_at: NOW + 5000, viewers: 10, tag: 'EPL' }),
    mk({ uri_name: 'live-high', name: 'Real vs Barca', starts_at: NOW - 100, ends_at: NOW + 5000, viewers: 99 }),
    mk({ uri_name: 'soon', name: 'Soon FC', starts_at: NOW + 600, ends_at: NOW + 9000 }),
    mk({ uri_name: 'later', name: 'Later FC', starts_at: NOW + 3600, ends_at: NOW + 9000 }),
    mk({ uri_name: 'over', name: 'Over FC', starts_at: NOW - 9000, ends_at: NOW - 10 })
  ] },
  { category: 'Boxing', streams: [
    mk({ uri_name: 'fight', name: 'Big Fight', category_name: 'Boxing', starts_at: NOW - 50, ends_at: NOW + 100, viewers: 50, source_tag: 'DAZN' }),
    mk({ uri_name: 'box247', name: 'Boxing 24/7', category_name: 'Boxing', always_live: 1 })
  ] }
]
const api = { getStreams: async () => groups }
const mkIface = (resolve = async () => 'http://m') => buildAddon({ api, resolvePlaylist: resolve, baseUrl: 'http://addon', now: () => NOW }).getInterface()
const ids = r => r.metas.map(m => m.id)

test('manifest', () => {
  assert.equal(manifest.id, 'org.ppvst.live')
  assert.deepEqual(manifest.idPrefixes, ['ppv:'])
  assert.equal(manifest.catalogs.length, 3)
})

test('live catalog filters and sorts', async () => {
  const r = await mkIface().get('catalog', 'series', 'ppv-live', {})
  // live (viewers desc; always-live have 0 viewers) then upcoming by start; 'later' and 'over' excluded
  assert.deepEqual(ids(r), ['ppv:live-high', 'ppv:fight', 'ppv:live-low', 'ppv:box247', 'ppv:soon'])
})

test('skip, search, genre', async () => {
  const i = mkIface()
  assert.deepEqual(ids(await i.get('catalog', 'series', 'ppv-live', { skip: '4' })), ['ppv:soon'])
  assert.deepEqual(ids(await i.get('catalog', 'series', 'ppv-live', { search: 'EPL' })), ['ppv:live-low'])
  assert.deepEqual(ids(await i.get('catalog', 'series', 'ppv-live', { search: 'dazn' })), ['ppv:fight'])
  assert.deepEqual(ids(await i.get('catalog', 'series', 'ppv-live', { genre: 'Boxing' })), ['ppv:fight', 'ppv:box247'])
  assert.deepEqual(ids(await i.get('catalog', 'series', 'ppv-category', { genre: 'Boxing' })), ['ppv:fight', 'ppv:box247'])
  assert.deepEqual((await i.get('catalog', 'series', 'ppv-category', {})).metas, [])
})

test('always catalog', async () => {
  assert.deepEqual(ids(await mkIface().get('catalog', 'series', 'ppv-always', {})), ['ppv:box247'])
})

test('meta shape', async () => {
  const m = (await mkIface().get('catalog', 'series', 'ppv-live', {})).metas[0]
  assert.equal(m.id, 'ppv:live-high')
  assert.equal(m.type, 'series')
  assert.equal(m.posterShape, 'landscape')
  assert.equal(m.background, m.poster)
  assert.equal(m.description, 'Football · src')
  assert.equal(m.releaseInfo, 'LIVE')
  assert.deepEqual(m.genres, ['Football'])
  assert.equal(m.behaviorHints.defaultVideoId, m.id)
})

test('page cap at 100', async () => {
  const big = [{ category: 'X', streams: Array.from({ length: 150 }, (_, n) => mk({ uri_name: 'a' + n, always_live: 1, category_name: 'X' })) }]
  const i = buildAddon({ api: { getStreams: async () => big }, resolvePlaylist: async () => 'x', baseUrl: 'http://addon', now: () => NOW }).getInterface()
  assert.equal((await i.get('catalog', 'series', 'ppv-always', {})).metas.length, 100)
  assert.equal((await i.get('catalog', 'series', 'ppv-always', { skip: '100' })).metas.length, 50)
})

test('stream handler', async () => {
  const seen = []
  const r = await mkIface(async u => { seen.push(u); return 'http://m' }).get('stream', 'series', 'ppv:live-high')
  assert.deepEqual(seen, ['live-high'])
  const s = r.streams[0]
  assert.equal(s.url, 'http://addon/p/live-high/master.m3u8')
  assert.equal(s.behaviorHints.notWebReady, true)
  assert.equal(s.behaviorHints.bingeGroup, 'ppvst-Football')
  assert.equal(s.title, 'src · LIVE')
  assert.equal(r.streams[1].externalUrl, 'https://ppv.st/live/live-high')
})

test('stream handler: resolve failure -> no streams', async () => {
  const warn = console.warn; console.warn = () => {}
  try {
    const r = await mkIface(async () => { throw new Error('boom') }).get('stream', 'series', 'ppv:live-high')
    assert.deepEqual(r, { streams: [] })
  } finally { console.warn = warn }
})
