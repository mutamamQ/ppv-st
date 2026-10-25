'use strict';
const express = require('express');
const { getRouter } = require('stremio-addon-sdk');

const PORT = Number(process.env.PORT) || 7000;
const ENV_BASE = (process.env.BASE_URL || '').replace(/\/+$/, '');

function tryRequire(p) {
  try { return require(p); } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && e.message.includes(p)) return null;
    throw e;
  }
}

let resolvePlaylist;
if (process.env.STUB_RESOLVE) {
  resolvePlaylist = async () => 'https://stub.invalid/secure/stub/0/0/stub/index.m3u8';
  console.warn('[server] STUB_RESOLVE=1: using fixed stub playlist URL');
} else {
  const r = tryRequire('./lib/resolve');
  if (r && typeof r.resolvePlaylist === 'function') resolvePlaylist = r.resolvePlaylist;
  else {
    console.warn('[server] lib/resolve.js not found; using stub that throws "resolver not implemented"');
    resolvePlaylist = async () => { throw new Error('resolver not implemented'); };
  }
}

const apiMod = tryRequire('./lib/api') || {};
const api = apiMod.api || apiMod;
const { buildAddon } = require('./lib/addon');
const { createProxy } = require('./lib/proxy');
const resolverMod = tryRequire('./lib/resolve');

// One addon router per base URL (derived from request host unless BASE_URL is set).
const routers = new Map();
function routerFor(baseUrl) {
  let r = routers.get(baseUrl);
  if (!r) {
    const addon = buildAddon({ api, resolvePlaylist, baseUrl });
    const iface = typeof addon.getInterface === 'function' ? addon.getInterface() : addon;
    r = getRouter(iface);
    routers.set(baseUrl, r);
  }
  return r;
}
function baseUrlOf(req) {
  return ENV_BASE || `${req.protocol}://${req.get('host')}`;
}

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(['/manifest.json', '/catalog', '/stream', '/meta'], (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/healthz', (req, res) => {
  let streams = 0;
  try {
    if (typeof api.cachedCount === 'function') streams = api.cachedCount();
    else if (typeof api.getStreams === 'function' && api._cache) streams = api.flatten ? api.flatten(api._cache).length : 0;
  } catch (_) {}
  res.json({ ok: true, uptime: Math.round(process.uptime()), streams });
});

app.get('/', (req, res) => {
  const base = baseUrlOf(req);
  const manifest = `${base}/manifest.json`;
  const stremio = manifest.replace(/^https?:\/\//, 'stremio://');
  const web = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifest)}`;
  res.type('html').send(`<!doctype html><meta charset=utf-8><title>ppv.st for Stremio</title>
<body style="font-family:sans-serif;max-width:40em;margin:3em auto">
<h1>ppv.st for Stremio</h1>
<p><a href="${stremio}">Install in Stremio app</a></p>
<p><a href="${web}">Install in Stremio Web</a></p>
<p>Manifest: <code>${manifest}</code></p></body>`);
});

app.use(createProxy({ resolvePlaylist, playlistGet: resolverMod && resolverMod.get }));

app.use((req, res, next) => routerFor(baseUrlOf(req))(req, res, next));

const server = app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));

function shutdown(sig) {
  console.log(`[server] ${sig}, shutting down`);
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server };
