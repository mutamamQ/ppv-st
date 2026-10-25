// CommonJS bridge to the ESM resolver (spike/resolve.mjs): runs the site's gasm.wasm to get the playlist url.
// resolve() mutates globals + shares one jwplayer stub, so calls are serialised through a promise chain.
let modP;
function load() { modP ||= import('./resolve.mjs'); return modP; }

let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const cache = new Map(); // uri -> {url, at}
const TTL = 4 * 60 * 1000;

function resolvePlaylist(uri) {
  const hit = cache.get(uri);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.url);
  return serial(async () => {
    const { resolve } = await load();
    const url = await resolve(uri);
    cache.set(uri, { url, at: Date.now() });
    return url;
  });
}

// fetch a playlist/manifest url through the pinned-cipher agent (indianservers.st JA3 gate)
async function get(url) {
  const { get: g } = await load();
  return g(url);
}

module.exports = { resolvePlaylist, get, CIPHERS: () => import('./resolve.mjs').then((m) => m.CIPHERS) };
