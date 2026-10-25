// Cloudflare worker in front of {universe}.r-universe.dev and r-universe.dev, see README.md. It does three things:
//  1. Reject requests for top-level pages that do not exist (e.g. from security scanners),
//     using the allowlist of the universe from /api/allowlist: its packages and universe pages.
//     On r-universe.dev it uses the top-level pages of the site.
//  2. Count hits per universe and package, in Workers Analytics Engine, and of r-universe.dev as
//     the universe '_global'. The stats are public on /cf/downloads and /cf/pageviews, see stats.js.
//  3. Record every package deployment (PUT and failure POST) in D1, see deploy.js.
// Downloads with a ?sha256= parameter are redirected to the file storage (R2) directly, as are
// CRAN urls of manuals to the manual on r-universe, and a
// known crawler fleet is blocked. Everything else goes to the backend unchanged. Responses have
// a header X-R-Universe-Edge: blocked, redirect, rejected, stats, pass (allowed), unchecked (no allowlist),
// or deploy.

import { stats, GLOBAL } from './stats.js';
import { deploy, isDeploy } from './deploy.js';

const UNIVERSE_HOST = /^([a-z0-9-]+)\.r-universe\.dev$/i;
const GLOBAL_HOST = 'r-universe.dev';

// Package files: /src/contrib/{package}_{version}.tar.gz or /bin/{platform}/.../{package}_{version}.{zip,tgz,tar.gz}
const DOWNLOAD = /^\/(?:src|bin\/([^/]+))\/.*\/([A-Za-z0-9.]+)_([^_/]+)\.(?:tar\.gz|tgz|zip)$/;

// Package files by their hash, e.g. /src/contrib/{package}_{version}.tar.gz?sha256={hash}
const SHA256 = /^[0-9a-f]{64}$/;
const STORAGE = 'https://r2.ropensci.org';

// The manual by its CRAN url, /{package}/{package}.pdf, which search engines request a lot.
// Its url on r-universe is /{package}/doc/manual.pdf.
const CRAN_MANUAL = /^\/([^/]+)\/([^/]+)\.pdf$/;

// A crawler fleet that downloads every dataset in every format, overloading the data export
// server (October 2026). Its user agent is that of a real browser, so it is only blocked from
// hosting networks (by ASN, mostly Hetzner, netcup and OVH), not from home and mobile ISPs.
const CRAWLER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0';
const HOSTING_ASNS = new Set([
  8560, 9009, 11798, 11878, 14061, 16276, 16509, 24940, 26666, 28753, 29066, 31898, 32489,
  36352, 41564, 42708, 46475, 49981, 51167, 51430, 53667, 57433, 60068, 61272, 63473, 197540,
  205548, 206804, 206996, 208172, 212238, 213881, 214677, 214996, 393577
]);

// Bots that ignore robots.txt (which disallows the data exports) and overload the data export
// server, blocked everywhere: rednote-websearch-bot (October 2026, from Alibaba Cloud).
const BLOCKED_BOTS = /rednote-websearch-bot/i;

const LIST_TTL = 300; // seconds to keep the allowlist of a universe (it changes rarely)
const RETRY_TTL = 60; // seconds before loading it again after a failure
const STALE_TTL = 3600; // seconds to keep answering with an expired allowlist while it reloads

// universe -> {expires, stale, list}. The list is {packages, universe}: Sets of lowercase
// names, null if the universe does not exist, or undefined if it could not be loaded.
// Until `stale`, an expired allowlist is still used while a new one loads in the background.
// Only loaded lists are kept, not promises of lists that are loading: a request can not wait for
// the I/O of another request (the runtime cancels it as hung, e.g. if that client disconnects).
const lists = new Map();

export default {
  async fetch(request, env, ctx) {
    if (isCrawler(request)) {
      return mark(new Response('Automated traffic from this network is blocked\n', {
        status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      }), 'blocked');
    }
    const url = new URL(request.url);
    if (url.hostname.toLowerCase() === GLOBAL_HOST && (request.method === 'GET' || request.method === 'HEAD')) {
      return checkGlobal(request, env, url, ctx);
    }
    const universe = url.hostname.match(UNIVERSE_HOST)?.[1].toLowerCase();
    if (universe && isDeploy(request, url)) {
      return mark(await deploy(request, env, ctx, universe, url), 'deploy');
    }
    if (!universe || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return fetch(request);
    }

    // Downloads by hash need neither the allowlist nor the backend
    const sha256 = url.searchParams.get('sha256');
    if (sha256 && SHA256.test(sha256)) {
      const download = describeDownload(url.pathname);
      if (download && request.method === 'GET') {
        record(env, universe, download, 301);
      }
      return mark(Response.redirect(`${STORAGE}/${sha256}`, 301), 'redirect');
    }

    // 1. Reject what does not exist. If the allowlist could not be loaded, let the backend decide.
    // The allowlist is lowercase: the frontend redirects other cases of package names.
    const allowed = await getAllowlist(universe, url.origin, ctx);
    const page = url.pathname.split('/')[1].toLowerCase();
    if (allowed === null) {
      return mark(notFound(`No packages found for this owner or maintainer: ${universe}`), 'rejected');
    }
    if (page === 'cf' && !allowed?.packages.has('cf')) {
      return mark(await stats(request, env, ctx, universe), 'stats');
    }
    if (allowed && !allowed.universe.has(page) && !allowed.packages.has(page)) {
      return mark(notFound(`Page not found: /${page}`), 'rejected');
    }
    const manual = url.pathname.match(CRAN_MANUAL);
    if (allowed?.packages.has(page) && manual?.[2].toLowerCase() === page) {
      return mark(redirect(`${url.origin}/${manual[1]}/doc/manual.pdf`), 'redirect');
    }

    // 2. Count the hit
    const response = await fetch(request);
    if (allowed && request.method === 'GET') {
      record(env, universe, describe(url.pathname, page, allowed), response.status);
    }
    return mark(response, allowed ? 'pass' : 'unchecked');
  }
};

// r-universe.dev: reject pages that do not exist, using its /api/allowlist (/_global/api/allowlist
// in the frontend), and count hits of its pages as the universe GLOBAL ('_global').
async function checkGlobal(request, env, url, ctx) {
  const allowed = await getAllowlist(GLOBAL, url.origin, ctx);
  const page = url.pathname.split('/')[1].toLowerCase();
  if (page === 'cf' && !allowed?.universe.has('cf')) {
    return mark(await stats(request, env, ctx, GLOBAL), 'stats');
  }
  if (allowed && !allowed.universe.has(page)) {
    return mark(notFound(`Page not found: /${page}`), 'rejected');
  }
  const response = await fetch(request);
  if (allowed && request.method === 'GET') {
    record(env, GLOBAL, describe(url.pathname, page, allowed), response.status);
  }
  return mark(response, allowed ? 'pass' : 'unchecked');
}

function isCrawler(request) {
  const agent = request.headers.get('User-Agent') || '';
  return BLOCKED_BOTS.test(agent) || (agent === CRAWLER_AGENT && HOSTING_ASNS.has(request.cf?.asn));
}

// Copy the response, because the headers of fetched and redirect responses are immutable
function mark(response, status) {
  const copy = new Response(response.body, response);
  copy.headers.set('X-R-Universe-Edge', status);
  return copy;
}

// One data point: [universe, type, package, version, page or platform], and the status
function record(env, universe, hit, status) {
  env.HITS?.writeDataPoint({ indexes: [universe], blobs: [universe, ...hit], doubles: [status] });
}

// What a request is about: [type, package, version, page or platform]
function describe(path, page, allowed) {
  const download = describeDownload(path);
  if (download) {
    return download;
  }
  const rest = path.split('/').slice(2).filter(Boolean);
  if (allowed.universe.has(page)) {
    // The page itself (/ for the homepage, /builds, /api), or /api/* for anything below it
    return ['universe', '', '', rest.length ? `/${page}/*` : `/${page}`];
  }
  // The landing page of the package (/), or the first part below it (/doc, /badges, ...)
  return ['package', page, '', `/${rest[0]?.toLowerCase() ?? ''}`];
}

function describeDownload(path) {
  const download = path.match(DOWNLOAD);
  if (!download) {
    return null;
  }
  const [, platform = 'src', pkg, version] = download;
  return ['download', pkg.toLowerCase(), version, platform];
}

async function getAllowlist(universe, origin, ctx) {
  const cached = lists.get(universe);
  if (cached && Date.now() < cached.expires) {
    return cached.list;
  }
  if (cached && Date.now() < cached.stale) {
    // Stale-while-revalidate: reload in the background, and use the new list once it is loaded.
    // Until then (or a minute after a failure) the old list is used without loading it again.
    cached.expires = Date.now() + RETRY_TTL * 1000;
    const reload = loadAllowlist(origin).then(list => lists.set(universe, newEntry(list)), () => {});
    ctx?.waitUntil(reload);
    return cached.list;
  }
  // Concurrent requests may each load it: cheap, because it is also cached at the edge
  try {
    const list = await loadAllowlist(origin);
    lists.set(universe, newEntry(list));
    return list;
  } catch {
    lists.set(universe, { expires: Date.now() + RETRY_TTL * 1000, stale: 0, list: undefined });
    return undefined;
  }
}

function newEntry(list) {
  const now = Date.now();
  return { expires: now + LIST_TTL * 1000, stale: now + STALE_TTL * 1000, list };
}

async function loadAllowlist(origin) {
  // ?v= is only the key in the edge cache: bump it when the Cache-Control of the frontend
  // changes, because Cloudflare keeps the headers of cached pages when revalidating them.
  const response = await fetch(`${origin}/api/allowlist?v=2`);
  if (response.status === 404 && (await response.text()).startsWith('Error: No packages found')) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for /api/allowlist`);
  }
  const data = await response.json();
  const lowercase = (names) => new Set(names.map(name => name.toLowerCase())); // already, to be safe
  return { packages: lowercase(data.packages), universe: lowercase(data.universe) };
}

// Permanent, so search engines update their links, and cached for a day
function redirect(location) {
  return new Response(null, { status: 301, headers: { Location: location, 'Cache-Control': 'public, max-age=86400' } });
}

function notFound(message) {
  return new Response(`${message}\n`, {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60' }
  });
}
