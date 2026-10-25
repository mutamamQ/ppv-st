const { addonBuilder } = require('stremio-addon-sdk')

const manifest = {
  id: 'org.ppvst.live',
  version: '0.1.0',
  name: 'ppv.st',
  description: 'Live sports and PPV streams from ppv.st: events happening now, upcoming, and 24/7 channels.',
  resources: ['catalog', 'stream'],
  types: ['series'],
  idPrefixes: ['ppv:'],
  catalogs: [
    { type: 'series', id: 'ppv-live', name: 'Live Now', extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }, { name: 'skip' }] },
    { type: 'series', id: 'ppv-always', name: '24/7 Channels' },
    { type: 'series', id: 'ppv-category', name: 'By Category', extra: [{ name: 'genre', isRequired: true }, { name: 'skip' }] }
  ],
  behaviorHints: { configurable: false, configurationRequired: false }
}

const PAGE = 100
const LEAD = 15 * 60

// api.getStreams() -> [{category, streams:[...]}]; flatten keeping category order
const flatten = groups => (groups || []).flatMap(g => (g.streams || []).map(s => ({ ...s, category_name: s.category_name || g.category })))

const isLive = (s, now) => !!s.always_live || !s.ends_at || (now >= s.starts_at && now <= s.ends_at)
const isListed = (s, now) => !!s.always_live || !s.ends_at || (now >= s.starts_at - LEAD && now <= s.ends_at)

function releaseInfo(s, now) {
  if (s.always_live) return '24/7'
  if (isLive(s, now)) return 'LIVE'
  return 'Starts ' + new Date(s.starts_at * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

const toMeta = (s, now) => ({
  id: 'ppv:' + s.uri_name,
  type: 'series',
  name: s.name,
  poster: s.poster,
  posterShape: 'landscape',
  background: s.poster,
  description: [s.category_name, s.source_tag, s.tag].filter(Boolean).join(' · '),
  releaseInfo: releaseInfo(s, now),
  genres: [s.category_name],
  behaviorHints: { defaultVideoId: 'ppv:' + s.uri_name }
})

function sortLive(list, now) {
  const live = list.filter(s => isLive(s, now) && (s.always_live || s.starts_at <= now))
  const up = list.filter(s => !live.includes(s))
  live.sort((a, b) => (b.viewers || 0) - (a.viewers || 0))
  up.sort((a, b) => a.starts_at - b.starts_at)
  return [...live, ...up]
}

function buildAddon({ api, resolvePlaylist, baseUrl, now = () => Date.now() / 1000 }) {
  const builder = new addonBuilder(manifest)

  builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
    if (type !== 'series') return { metas: [] }
    const t = now()
    let list = flatten(await api.getStreams())
    if (id === 'ppv-always') list = list.filter(s => s.always_live)
    else if (id === 'ppv-live' || id === 'ppv-category') {
      list = sortLive(list.filter(s => isListed(s, t)), t)
      if (id === 'ppv-category' && !extra.genre) return { metas: [] }
    } else return { metas: [] }
    if (extra.genre) list = list.filter(s => s.category_name === extra.genre)
    if (extra.search) {
      const q = String(extra.search).toLowerCase()
      list = list.filter(s => [s.name, s.tag, s.source_tag, s.category_name].some(v => String(v || '').toLowerCase().includes(q)))
    }
    const skip = parseInt(extra.skip) || 0
    return { metas: list.slice(skip, skip + PAGE).map(s => toMeta(s, t)) }
  })

  builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== 'series' || !id.startsWith('ppv:')) return { streams: [] }
    const uri = id.slice(4)
    try {
      await resolvePlaylist(uri)
    } catch (e) {
      console.warn(`ppv: resolve failed for ${uri}: ${e.message}`)
      return { streams: [] }
    }
    // category/source for labels; best-effort, not fatal
    let s = {}
    try { s = flatten(await api.getStreams()).find(x => x.uri_name === uri) || {} } catch {}
    const t = now()
    return {
      streams: [
        {
          name: 'ppv.st',
          title: (s.source_tag || uri) + ' · ' + (!s.uri_name || isLive(s, t) ? 'LIVE' : 'stream'),
          url: baseUrl + '/p/' + encodeURIComponent(uri) + '/master.m3u8',
          behaviorHints: { notWebReady: true, bingeGroup: 'ppvst-' + (s.category_name || 'live') }
        },
        { name: 'ppv.st web', title: 'Open in browser', externalUrl: 'https://ppv.st/live/' + encodeURIComponent(uri) }
      ]
    }
  })

  return builder
}

module.exports = { buildAddon, manifest }
