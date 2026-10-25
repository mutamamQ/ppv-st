'use strict';
// ppv.st catalogue API client: domain discovery, caching, single-flight, stale-on-error.

const DEFAULT_PING = 'https://api.ppv.st/api/ping';
const FALLBACK_DOMAINS = ['api.ppv.st', 'api.ppv.tj', 'api.ppvs.pk', 'api.ppv.rw', 'api.ppv.ms', 'api.ppv.bi', 'api.ppv.ug'];
const BACKUP_BASE = 'https://api.ppv.cx/api';

function createApi(opts = {}) {
  const o = {
    pingUrl: DEFAULT_PING,
    fallbackBases: FALLBACK_DOMAINS.map((d) => `https://${d}/api`).concat(BACKUP_BASE),
    timeoutMs: 8000,
    streamsTtlMs: 60 * 1000,
    domainTtlMs: 10 * 60 * 1000,
    retryDelayMs: 250,
    now: Date.now,
    ...opts,
  };

  let domains = null; // { bases, at }
  let domainsFlight = null;
  let streamsCache = null; // { data, at }
  let streamsFlight = null;
  let preferred = null; // last base that worked

  async function fetchJsonOnce(url) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(o.timeoutMs),
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (stremio-ppv-addon)' },
    });
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status} for ${url}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  // Retry once on network error / 5xx (not on 4xx).
  async function fetchJson(url) {
    try {
      return await fetchJsonOnce(url);
    } catch (e) {
      if (e.status && e.status < 500) throw e;
      await new Promise((r) => setTimeout(r, o.retryDelayMs));
      return fetchJsonOnce(url);
    }
  }

  async function loadBases() {
    if (domains && o.now() - domains.at < o.domainTtlMs) return domains.bases;
    if (domainsFlight) return domainsFlight;
    domainsFlight = (async () => {
      let bases;
      try {
        const p = await fetchJson(o.pingUrl);
        const list = Array.isArray(p && p.domains) ? p.domains.filter((d) => typeof d === 'string' && d) : [];
        if (!list.length) throw new Error('ping returned no domains');
        bases = list.map((d) => `https://api.${d.replace(/^api\./, '')}/api`);
        bases.push(...o.fallbackBases.filter((b) => !bases.includes(b)));
      } catch (_) {
        bases = o.fallbackBases.slice();
      }
      domains = { bases, at: o.now() };
      return bases;
    })().finally(() => { domainsFlight = null; });
    return domainsFlight;
  }

  // Try each base (last-good first) until one yields a valid response.
  async function request(path) {
    let bases = await loadBases();
    if (preferred && bases.includes(preferred)) bases = [preferred, ...bases.filter((b) => b !== preferred)];
    let lastErr;
    for (const base of bases) {
      try {
        const body = await fetchJson(base + path);
        preferred = base;
        return body;
      } catch (e) {
        lastErr = e;
        if (e.status === 404) throw e; // definitive answer, don't hop domains
      }
    }
    throw lastErr || new Error('no API base available');
  }

  async function getStreams() {
    if (streamsCache && o.now() - streamsCache.at < o.streamsTtlMs) return streamsCache.data;
    if (streamsFlight) return streamsFlight;
    streamsFlight = request('/streams')
      .then((body) => {
        if (!body || !Array.isArray(body.streams)) throw new Error('unexpected /streams response');
        streamsCache = { data: body.streams, at: o.now() };
        return body.streams;
      })
      .catch((e) => {
        if (streamsCache) return streamsCache.data; // stale-on-error
        throw e;
      })
      .finally(() => { streamsFlight = null; });
    return streamsFlight;
  }

  async function getStream(uriName) {
    const body = await request(`/streams/${encodeURIComponent(uriName)}`);
    if (!body || !body.data) throw new Error(`no data for stream ${uriName}`);
    return body.data;
  }

  async function flatten() {
    const cats = await getStreams();
    const out = [];
    for (const cat of cats) {
      for (const s of cat.streams || []) {
        out.push({
          id: s.id,
          name: s.name,
          tag: s.tag,
          source_tag: s.source_tag,
          poster: s.poster,
          uri_name: s.uri_name,
          starts_at: s.starts_at,
          ends_at: s.ends_at,
          always_live: s.always_live,
          category_name: s.category_name || cat.category,
          iframe: s.iframe,
          substreams: s.substreams || [],
          viewers: s.viewers,
        });
      }
    }
    return out;
  }

  return { getStreams, getStream, flatten, createApi, _reset() { domains = streamsCache = preferred = null; } };
}

module.exports = createApi();
module.exports.createApi = createApi;
