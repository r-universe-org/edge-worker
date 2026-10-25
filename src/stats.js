// Public stats of a universe from the hits in Analytics Engine, see README.md:
//   /cf/downloads?days=30  downloads per package and platform
//   /cf/pageviews?days=30  views of the universe pages and the package landing pages
//   /cf/deployments?days=30&limit=100&package=  the latest package deployments, from D1 (see deploy.js)
// And on r-universe.dev (the universe GLOBAL):
//   /cf/downloads?days=30&top=100  downloads of all universes: totals, and the top universes and packages
//   /cf/pageviews?days=30  views of the pages of r-universe.dev
// Analytics Engine can only be read with the SQL API, which requires an API token (the secret
// ANALYTICS_TOKEN). Results are cached at the edge, so the SQL API is queried at most once
// per universe, type and number of days per hour (per data center).

import { listDeployments } from './deploy.js';

const CACHE_TTL = 3600;
const DEPLOYMENTS_TTL = 300; // deployments are mostly interesting while they happen
const MAX_DAYS = 90; // Analytics Engine keeps data for three months
const MAX_DEPLOYMENT_DAYS = 3650; // D1 keeps them forever
const MAX_TOP = 1000;

// The hits of r-universe.dev are counted as this universe, which can not be a universe name
export const GLOBAL = '_global';

// Universe pages that are html pages for visitors, rather than files or data
const HTML_PAGES = ['/', '/builds', '/packages', '/badges', '/api', '/datasets', '/contributors', '/articles'];

// Pages of r-universe.dev that are html pages
const GLOBAL_HTML_PAGES = ['/', '/search', '/activity', '/builds', '/organizations', '/repositories', '/packages',
  '/articles', '/datasets', '/sysdeps', '/galaxy', '/welcome'];

const STATS = { downloads, pageviews, deployments: listDeployments };
const GLOBAL_STATS = { downloads: globalDownloads, pageviews: globalPageviews };

export async function stats(request, env, ctx, universe) {
  const url = new URL(request.url);
  const type = url.pathname.match(/^\/cf\/([a-z]+)\/?$/i)?.[1].toLowerCase();
  const global = universe === GLOBAL;
  const types = global ? GLOBAL_STATS : STATS;
  if (!Object.hasOwn(types, type)) {
    const list = global ? '/cf/downloads or /cf/pageviews' : '/cf/downloads, /cf/pageviews or /cf/deployments';
    return error(404, `Stats not found: ${url.pathname} (use ${list})`);
  }
  const options = parseOptions(url.searchParams, type, global);

  // One cache entry for all spellings of the same request
  const key = new Request(`${url.origin}/cf/${type}?${new URLSearchParams(options)}`);
  const cached = await caches.default.match(key);
  if (cached) {
    return cached;
  }
  if (type === 'deployments' ? !env.DEPLOYS : !env.ANALYTICS_TOKEN || !env.ANALYTICS_ACCOUNT) {
    const missing = type === 'deployments' ? 'the DEPLOYS database' : 'ANALYTICS_TOKEN or ANALYTICS_ACCOUNT';
    return error(503, `Stats are not available (no ${missing})`);
  }
  let body;
  try {
    const result = await types[type](env, universe, options);
    body = global ? { ...options, ...result } : { universe, ...options, ...result };
  } catch (e) {
    return error(502, `Failed to query stats: ${e.message}`);
  }
  const response = Response.json(body, {
    headers: {
      'Cache-Control': `public, max-age=${type === 'deployments' ? DEPLOYMENTS_TTL : CACHE_TTL}`,
      'Access-Control-Allow-Origin': '*'
    }
  });
  ctx?.waitUntil(caches.default.put(key, response.clone()));
  return response;
}

// The options of each type, with defaults and limits, in a fixed order (they are the cache key)
function parseOptions(params, type, global) {
  const int = (name, fallback, max) => Math.min(Math.max(parseInt(params.get(name)) || fallback, 1), max);
  if (type === 'deployments') {
    const pkg = params.get('package');
    const options = { days: int('days', 30, MAX_DEPLOYMENT_DAYS), limit: int('limit', 100, MAX_TOP) };
    return pkg ? { ...options, package: pkg } : options;
  }
  const days = int('days', 30, MAX_DAYS);
  return global && type === 'downloads' ? { days, top: int('top', 100, MAX_TOP) } : { days };
}

// {downloads, packages: [{package, downloads, platforms: {platform: downloads}}]}
async function downloads(env, universe, { days }) {
  const rows = await query(env, `SELECT blob3 AS package, blob5 AS platform, SUM(_sample_interval) AS count
    FROM r_universe_hits WHERE index1 = '${universe}' AND blob2 = 'download'
    AND double1 < 400 AND timestamp > NOW() - INTERVAL '${days}' DAY
    GROUP BY package, platform FORMAT JSON`);
  const packages = {};
  for (const row of rows) {
    const pkg = packages[row.package] ??= { package: row.package, downloads: 0, platforms: {} };
    pkg.downloads += row.count;
    pkg.platforms[row.platform] = row.count;
  }
  const list = Object.values(packages).sort((a, b) => b.downloads - a.downloads);
  return { downloads: sum(list.map(x => x.downloads)), packages: list };
}

// {pageviews, pages: {page: views}, packages: [{package, pageviews}]}. Only successful
// responses count (200 or 304), not for example the redirect of /DPLYR to /dplyr.
async function pageviews(env, universe, { days }) {
  const rows = await query(env, `SELECT blob2 AS type, blob3 AS package, blob5 AS page, SUM(_sample_interval) AS count
    FROM r_universe_hits WHERE index1 = '${universe}' AND (blob2 = 'universe' OR (blob2 = 'package' AND blob5 = '/'))
    AND (double1 = 200 OR double1 = 304) AND timestamp > NOW() - INTERVAL '${days}' DAY
    GROUP BY type, package, page FORMAT JSON`);
  const pages = {};
  const packages = [];
  for (const row of rows) {
    if (row.type === 'package') {
      packages.push({ package: row.package, pageviews: row.count });
    } else if (HTML_PAGES.includes(row.page)) {
      pages[row.page] = row.count;
    }
  }
  packages.sort((a, b) => b.pageviews - a.pageviews);
  return { pageviews: sum(Object.values(pages)) + sum(packages.map(x => x.pageviews)), pages, packages };
}

// Downloads of all universes: {downloads, universes, platforms: {platform: downloads},
// top_universes: [{universe, downloads}], top_packages: [{universe, package, downloads}]}
async function globalDownloads(env, universe, { days, top }) {
  const where = `blob2 = 'download' AND double1 < 400 AND timestamp > NOW() - INTERVAL '${days}' DAY`;
  const [platforms, count, universes, packages] = await Promise.all([
    query(env, `SELECT blob5 AS platform, SUM(_sample_interval) AS count
      FROM r_universe_hits WHERE ${where} GROUP BY platform FORMAT JSON`),
    query(env, `SELECT COUNT(DISTINCT blob1) AS count FROM r_universe_hits WHERE ${where} FORMAT JSON`),
    query(env, `SELECT blob1 AS universe, SUM(_sample_interval) AS count
      FROM r_universe_hits WHERE ${where} GROUP BY universe ORDER BY count DESC LIMIT ${top} FORMAT JSON`),
    query(env, `SELECT blob1 AS universe, blob3 AS package, SUM(_sample_interval) AS count
      FROM r_universe_hits WHERE ${where} GROUP BY universe, package ORDER BY count DESC LIMIT ${top} FORMAT JSON`)
  ]);
  platforms.sort((a, b) => b.count - a.count);
  return {
    downloads: sum(platforms.map(x => x.count)),
    universes: count[0]?.count ?? 0,
    platforms: Object.fromEntries(platforms.map(x => [x.platform, x.count])),
    top_universes: universes.map(x => ({ universe: x.universe, downloads: x.count })),
    top_packages: packages.map(x => ({ universe: x.universe, package: x.package, downloads: x.count }))
  };
}

// Views of the pages of r-universe.dev: {pageviews, pages: {page: views}}
async function globalPageviews(env, universe, { days }) {
  const rows = await query(env, `SELECT blob5 AS page, SUM(_sample_interval) AS count
    FROM r_universe_hits WHERE index1 = '${GLOBAL}' AND blob2 = 'universe'
    AND (double1 = 200 OR double1 = 304) AND timestamp > NOW() - INTERVAL '${days}' DAY
    GROUP BY page FORMAT JSON`);
  const pages = Object.fromEntries(rows.filter(x => GLOBAL_HTML_PAGES.includes(x.page)).map(x => [x.page, x.count]));
  return { pageviews: sum(Object.values(pages)), pages };
}

// The SQL API has no query parameters: the universe comes from the hostname (a-z, 0-9 and -)
// and days and top are integers, so they are safe to use in the query.
async function query(env, sql) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ANALYTICS_ACCOUNT}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.ANALYTICS_TOKEN}` },
    body: sql
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from the SQL API: ${await response.text()}`);
  }
  const { data } = await response.json();
  return data.map(row => ({ ...row, count: Number(row.count) }));
}

function sum(numbers) {
  return numbers.reduce((a, b) => a + b, 0);
}

function error(status, message) {
  return new Response(`${message}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
