// Public stats of a universe from the hits in Analytics Engine, see README.md:
//   /cf/downloads?days=30  downloads per package and platform
//   /cf/pageviews?days=30  views of the universe pages and the package landing pages
// Analytics Engine can only be read with the SQL API, which requires an API token (the secret
// ANALYTICS_TOKEN). Results are cached at the edge, so the SQL API is queried at most once
// per universe, type and number of days per hour (per data center).

const CACHE_TTL = 3600;
const MAX_DAYS = 90; // Analytics Engine keeps data for three months

// Universe pages that are html pages for visitors, rather than files or data
const HTML_PAGES = ['/', '/builds', '/packages', '/badges', '/api', '/datasets', '/contributors', '/articles'];

const STATS = { downloads, pageviews };

export async function stats(request, env, ctx, universe) {
  const url = new URL(request.url);
  const type = url.pathname.match(/^\/cf\/([a-z]+)\/?$/i)?.[1].toLowerCase();
  if (!Object.hasOwn(STATS, type)) {
    return error(404, `Stats not found: ${url.pathname} (use /cf/downloads or /cf/pageviews)`);
  }
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days')) || 30, 1), MAX_DAYS);

  // One cache entry for all spellings of the same request
  const key = new Request(`${url.origin}/cf/${type}?days=${days}`);
  const cached = await caches.default.match(key);
  if (cached) {
    return cached;
  }
  if (!env.ANALYTICS_TOKEN || !env.ANALYTICS_ACCOUNT) {
    return error(503, 'Stats are not available (no ANALYTICS_TOKEN or ANALYTICS_ACCOUNT)');
  }
  let body;
  try {
    body = { universe, days, ...(await STATS[type](env, universe, days)) };
  } catch (e) {
    return error(502, `Failed to query stats: ${e.message}`);
  }
  const response = Response.json(body, {
    headers: { 'Cache-Control': `public, max-age=${CACHE_TTL}`, 'Access-Control-Allow-Origin': '*' }
  });
  ctx?.waitUntil(caches.default.put(key, response.clone()));
  return response;
}

// {downloads, packages: [{package, downloads, platforms: {platform: downloads}}]}
async function downloads(env, universe, days) {
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
async function pageviews(env, universe, days) {
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

// The SQL API has no query parameters: the universe comes from the hostname (a-z, 0-9 and -)
// and days is an integer, so they are safe to use in the query.
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
