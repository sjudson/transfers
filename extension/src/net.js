// Rate-limited, cached fetching of pcmdaily.com pages.
//
// Guarantees against hammering upstream:
//  * concurrency 1 (a serial queue) + a hard minimum gap between network hits;
//  * per-URL TTL: within TTL we serve the cached body with NO network hit.
//
// We deliberately do NOT send conditional-GET validators (If-None-Match /
// If-Modified-Since). pcmdaily (PHP-Fusion) ties a thread's Last-Modified to the
// *viewer's* read tracking, so reading a thread on another device advances your
// server-side read marker and the server then answers our conditional GET with a
// 304 even though a new post changed the content — leaving us serving the stale
// cached body (e.g. "you're still leading" after being outbid). Full GETs, still
// throttled by the queue + per-URL TTL, keep us gentle without that correctness
// hole. See DATA_VERSION bump that flushes any already-stale cache on upgrade.
import { httpCache } from './db.js';

const ORIGIN = 'https://pcmdaily.com';
const MIN_GAP_MS = 200; // hard floor between requests (~5/s; the worker paces in 5s chunks)

let _lastHit = 0;
let _chain = Promise.resolve();
export const netStats = { hits: 0, conditional304: 0, served304Body: 0, lastError: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serialize + throttle every actual network access.
function schedule(fn) {
  const run = _chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - _lastHit);
    if (wait > 0) await sleep(wait);
    try { return await fn(); }
    finally { _lastHit = Date.now(); }
  });
  // keep the chain alive regardless of individual failures
  _chain = run.catch(() => {});
  return run;
}

function absolute(url) {
  if (url.startsWith('http')) return url;
  return ORIGIN + '/forum/' + url.replace(/^\/?forum\//, '').replace(/^\//, '');
}

// Fetch a forum page with caching.
// opts: { ttlMs=30000, force=false }
// returns { body, status, fromCache, notModified, loginRequired, fetchedAtUtcMs, dateHeader }
export async function fetchPage(url, opts = {}) {
  const abs = absolute(url);
  const ttlMs = opts.ttlMs ?? 30000;
  const cached = await httpCache.get(abs);
  const now = Date.now();

  if (cached && !opts.force && now - cached.ts < ttlMs) {
    return {
      body: cached.body, status: cached.status, fromCache: true,
      notModified: false, loginRequired: false,
      fetchedAtUtcMs: cached.fetchedAtUtcMs ?? cached.ts, dateHeader: cached.dateHeader || null,
    };
  }

  return schedule(async () => {
    // No conditional-GET validators on purpose (see file header): the server's
    // 304s are unreliable for our change-detection, so we always take the body.
    const headers = {};

    let resp;
    try {
      resp = await fetch(abs, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-store',
        headers,
      });
    } catch (e) {
      netStats.lastError = String(e);
      if (cached) return { body: cached.body, status: cached.status, fromCache: true, stale: true, notModified: false, loginRequired: false, fetchedAtUtcMs: cached.ts, error: String(e) };
      throw e;
    }
    netStats.hits++;
    const dateHeader = resp.headers.get('date');
    const fetchedAtUtcMs = dateHeader ? Date.parse(dateHeader) : Date.now();

    // Login gate: viewforum bounces logged-out users to index.php.
    if (resp.redirected && /\/index\.php(\?|$)/.test(resp.url) && /viewforum\.php/.test(abs)) {
      return { body: '', status: resp.status, fromCache: false, notModified: false, loginRequired: true, fetchedAtUtcMs, dateHeader };
    }

    if (resp.status === 304 && cached) {
      netStats.conditional304++;
      await httpCache.put({ ...cached, ts: Date.now(), fetchedAtUtcMs, dateHeader });
      return { body: cached.body, status: 304, fromCache: true, notModified: true, loginRequired: false, fetchedAtUtcMs, dateHeader };
    }

    const body = await resp.text();
    const loginRequired = /viewforum\.php/.test(abs) && /\/index\.php(\?|$)/.test(resp.url);
    const rec = {
      url: abs, ts: Date.now(), fetchedAtUtcMs, dateHeader,
      etag: resp.headers.get('etag') || null,
      lastModified: resp.headers.get('last-modified') || null,
      status: resp.status, body,
    };
    await httpCache.put(rec);
    return { body, status: resp.status, fromCache: false, notModified: false, loginRequired, fetchedAtUtcMs, dateHeader };
  });
}
