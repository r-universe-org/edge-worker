import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// A fake backend: /api/allowlist returns the allowlist, other pages return 200 (downloads a 302)
let list, calls, points;
let sqlRows, sqlQueries;
let deployResponse; // the response of the server to deployments
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (deployResponse && url.pathname.startsWith('/api/packages/')) {
    calls.push(`${input.method} ${url.pathname}`);
    return deployResponse();
  }
  if (url.hostname === 'api.cloudflare.com') { // fake SQL API of Analytics Engine
    sqlQueries.push({ url: url.href, auth: init.headers.Authorization, sql: init.body });
    return typeof sqlRows === 'function' ? sqlRows() : Response.json({ data: sqlRows });
  }
  calls.push(url.pathname);
  if (url.pathname === '/api/allowlist') {
    return typeof list === 'function' ? list() : Response.json(list);
  }
  if (/\.(tar\.gz|tgz|zip)$/.test(url.pathname)) {
    return new Response(null, { status: url.pathname.includes('missing') ? 404 : 302 });
  }
  return new Response('page');
};

// The worker keeps allowlists in memory per universe, so each test uses a new universe
let universe = 0;
beforeEach(() => {
  universe++;
  list = { packages: ['data.table', 'dplyr', 'rappArmor', 'tidyr'], universe: ['', 'api', 'bin', 'builds', 'card.png', 'src'] };
  calls = []; points = [];
  sqlRows = []; sqlQueries = [];
  deployResponse = undefined; deployRows = [];
});

// A fake edge cache
const cache = new Map();
globalThis.caches = { default: {
  match: async (key) => cache.get(key.url)?.clone(),
  put: async (key, response) => { cache.set(key.url, response); }
} };

// fake Analytics Engine and D1
let deployRows;
const env = {
  HITS: { writeDataPoint: (point) => points.push(point) },
  DEPLOYS: { prepare: (sql) => ({ bind: (...values) => ({ run: async () => deployRows.push({ sql, values }) }) }) }
};
function get(path, method = 'GET', host = `test${universe}.r-universe.dev`) {
  return worker.fetch(new Request(`https://${host}${path}`, { method }), env);
}

test('passes packages and pages to the backend', async () => {
  for (const path of ['/', '/dplyr', '/DPLYR/doc/manual.html', '/Data.Table', '/api/packages', '/API/x', '/builds', '/card.png', '/RAppArmor']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('X-R-Universe-Edge'), 'pass');
  }
  assert.equal(calls.filter(x => x === '/api/allowlist').length, 1); // loaded once
});

test('rejects pages that do not exist', async () => {
  for (const path of ['/wp-admin/setup.php', '/.env', '/ggplot2', '/packages']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get('X-R-Universe-Edge'), 'rejected');
  }
  assert.deepEqual(calls, ['/api/allowlist']);
});

test('rejects everything on a universe that does not exist', async () => {
  list = () => new Response('Error: No packages found for this owner or maintainer: test\n', { status: 404 });
  const res = await get('/');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /No packages found/);
  assert.equal(res.headers.get('X-R-Universe-Edge'), 'rejected');
  assert.deepEqual(calls, ['/api/allowlist']);
});

test('passes everything when the allowlist can not be loaded', async () => {
  list = () => new Response('Bad gateway', { status: 502 });
  const res = await get('/wp-admin');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-R-Universe-Edge'), 'unchecked');
});

test('reloads the allowlist after 5 minutes in the background, using the old one meanwhile', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  const visit = (path) => worker.fetch(new Request(`https://test${universe}.r-universe.dev${path}`), env, ctx);
  const loads = () => calls.filter(x => x === '/api/allowlist').length;
  await visit('/');
  t.mock.timers.tick(299 * 1000);
  await visit('/');
  assert.equal(loads(), 1);

  // Expired: the request does not wait for the reload, which never finishes here
  t.mock.timers.tick(2 * 1000);
  list = () => new Promise(() => {});
  assert.equal((await visit('/dplyr')).status, 200);
  assert.equal((await visit('/ggplot2')).status, 404);
  assert.equal(loads(), 2); // reloading once at a time
  assert.equal(pending.length, 1);
  pending.length = 0; // do not wait for it below

  // A failed reload keeps the old list, and tries again after a minute
  t.mock.timers.tick(61 * 1000);
  list = () => new Response('Bad gateway', { status: 502 });
  assert.equal((await visit('/ggplot2')).status, 404);
  await Promise.all(pending);
  assert.equal((await visit('/ggplot2')).status, 404);
  assert.equal(loads(), 3);

  // A successful reload is used once it is loaded
  t.mock.timers.tick(61 * 1000);
  list = { packages: ['ggplot2'], universe: [''] };
  assert.equal((await visit('/ggplot2')).status, 404);
  await Promise.all(pending);
  assert.equal((await visit('/ggplot2')).status, 200);
  assert.equal(loads(), 4);

  // After an hour the old list is too old: wait for the new one
  t.mock.timers.tick(3601 * 1000);
  list = { packages: ['tidyr'], universe: [''] };
  assert.equal((await visit('/tidyr')).status, 200);
  assert.equal(loads(), 5);
});

test('retries an allowlist that could not be loaded after 1 minute, without using it when stale', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const loads = () => calls.filter(x => x === '/api/allowlist').length;
  list = () => new Response('Bad gateway', { status: 502 });
  assert.equal((await get('/ggplot2')).headers.get('X-R-Universe-Edge'), 'unchecked');
  t.mock.timers.tick(59 * 1000);
  await get('/');
  assert.equal(loads(), 1);
  t.mock.timers.tick(2 * 1000);
  list = { packages: ['dplyr'], universe: [''] };
  assert.equal((await get('/ggplot2')).status, 404); // waited for the new list
  assert.equal(loads(), 2);
});

test('blocks bots that ignore robots.txt everywhere', async () => {
  for (const host of [`test${universe}.r-universe.dev`, 'r-universe.dev']) {
    const request = new Request(`https://${host}/dplyr/data/x/csv`, { headers: { 'User-Agent': 'rednote-websearch-bot' } });
    const res = await worker.fetch(request, env);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('X-R-Universe-Edge'), 'blocked');
  }
  assert.deepEqual(calls, []);
  assert.equal(points.length, 0);
});

test('blocks the crawler fleet from hosting networks only', async () => {
  const agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0';
  const visit = (asn, ua = agent, host = `test${universe}.r-universe.dev`) => {
    const request = new Request(`https://${host}/dplyr/data/x/csv`, { headers: { 'User-Agent': ua } });
    Object.defineProperty(request, 'cf', { value: { asn } }); // set by Cloudflare
    return worker.fetch(request, env);
  };
  for (const res of [await visit(24940), await visit(16276, agent, 'r-universe.dev')]) {
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('X-R-Universe-Edge'), 'blocked');
  }
  assert.deepEqual(calls, []);
  assert.equal(points.length, 0);
  assert.equal((await visit(3320)).status, 200); // home ISP
  assert.equal((await visit(24940, agent.replaceAll('148', '149'))).status, 200); // other browser
  assert.equal((await visit(undefined)).status, 200);
});

test('does not wait for an allowlist that another request is loading', async () => {
  list = () => new Promise(() => {}); // e.g. the first client disconnected, so it never loads
  get('/dplyr'); // not awaited
  list = { packages: ['dplyr'], universe: [''] };
  const res = await get('/dplyr'); // would hang if it waited for the first load
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-R-Universe-Edge'), 'pass');
});

test('passes other hosts and methods without loading the allowlist', async () => {
  await get('/wp-admin', 'GET', 'docs.ropensci.org');
  await get('/wp-admin', 'POST');
  await get('/webhook', 'POST', 'r-universe.dev');
  assert.deepEqual(calls, ['/wp-admin', '/wp-admin', '/webhook']);
});

test('rejects pages that do not exist on r-universe.dev, and counts hits of the others', async () => {
  list = { packages: [], universe: ['', 'search', 'api', 'cranstatus'] };
  for (const path of ['/', '/search', '/Search?q=x', '/api/search', '/cranstatus/sf']) {
    const res = await get(path, 'GET', 'r-universe.dev');
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('X-R-Universe-Edge'), 'pass');
  }
  await get('/search', 'HEAD', 'r-universe.dev'); // only GET
  for (const path of ['/wp-admin.php', '/.env', '/dplyr']) {
    const res = await get(path, 'GET', 'r-universe.dev');
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get('X-R-Universe-Edge'), 'rejected');
  }
  assert.equal(calls.filter(x => x === '/api/allowlist').length, 1);
  assert.deepEqual(points.map(x => x.blobs.slice(1)), [
    ['universe', '', '', '/'],
    ['universe', '', '', '/search'],
    ['universe', '', '', '/search'],
    ['universe', '', '', '/api/*'],
    ['universe', '', '', '/cranstatus/*']
  ]);
  assert.ok(points.every(x => x.indexes[0] === '_global' && x.blobs[0] === '_global'));
});

test('counts hits of packages, downloads, and universe pages', async () => {
  await get('/dplyr');
  await get('/DPLYR/doc/manual.html');
  await get('/dplyr/badges/version');
  await get('/src/contrib/dplyr_1.1.4.tar.gz');
  await get('/bin/windows/contrib/4.5/data.table_1.16.0.zip');
  await get('/bin/macosx/big-sur-arm64/contrib/4.5/RAppArmor_3.2.tgz');
  await get('/bin/linux/noble-x86_64/4.5/src/contrib/tidyr_1.3.1.tar.gz');
  await get('/src/contrib/missing_1.0.tar.gz');
  await get('/src/contrib/PACKAGES.gz');
  await get('/builds');
  await get('/builds/');
  await get('/api/packages');
  await get('/');
  await get('/dplyr', 'HEAD'); // only GET
  await get('/wp-admin'); // rejected
  const name = `test${universe}`;
  assert.deepEqual(points.map(x => x.blobs), [
    [name, 'package', 'dplyr', '', '/'],
    [name, 'package', 'dplyr', '', '/doc'],
    [name, 'package', 'dplyr', '', '/badges'],
    [name, 'download', 'dplyr', '1.1.4', 'src'],
    [name, 'download', 'data.table', '1.16.0', 'windows'],
    [name, 'download', 'rapparmor', '3.2', 'macosx'],
    [name, 'download', 'tidyr', '1.3.1', 'linux'],
    [name, 'download', 'missing', '1.0', 'src'],
    [name, 'universe', '', '', '/src/*'],
    [name, 'universe', '', '', '/builds'],
    [name, 'universe', '', '', '/builds'],
    [name, 'universe', '', '', '/api/*'],
    [name, 'universe', '', '', '/']
  ]);
  assert.deepEqual(points.map(x => x.doubles[0]), [200, 200, 200, 302, 302, 302, 302, 404, 200, 200, 200, 200, 200]);
  assert.ok(points.every(x => x.indexes[0] === name));
});

test('no hits without the allowlist', async () => {
  list = () => new Response('Bad gateway', { status: 502 });
  await get('/dplyr');
  assert.equal(points.length, 0);
});

test('redirects downloads by hash to the file storage, without the backend', async () => {
  const hash = '806953e2f92f4109c6a0311430b922fb845888be513922ded23c323757a9c4fb';
  for (const path of [`/src/contrib/V8_8.2.0.tar.gz?sha256=${hash}`, `/anything?sha256=${hash}`]) {
    const res = await get(path);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('Location'), `https://r2.ropensci.org/${hash}`);
    assert.equal(res.headers.get('X-R-Universe-Edge'), 'redirect');
  }
  await get(`/src/contrib/V8_8.2.0.tar.gz?sha256=${hash}`, 'HEAD');
  assert.deepEqual(calls, []);
  assert.deepEqual(points.map(x => x.blobs), [[`test${universe}`, 'download', 'v8', '8.2.0', 'src']]);
  assert.deepEqual(points.map(x => x.doubles[0]), [301]);
});

test('redirects CRAN urls of manuals of existing packages', async () => {
  for (const path of ['/dplyr/dplyr.pdf', '/RAppArmor/RAppArmor.pdf?x=1', '/rapparmor/RAPPARMOR.pdf']) {
    const res = await get(path);
    const pkg = path.split('/')[1];
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get('Location'), `https://test${universe}.r-universe.dev/${pkg}/doc/manual.pdf`);
    assert.equal(res.headers.get('X-R-Universe-Edge'), 'redirect');
  }
  assert.equal((await get('/dplyr/tidyr.pdf')).status, 200); // other pdfs go to the backend
  assert.equal((await get('/dplyr/doc/dplyr.pdf')).status, 200);
  assert.equal((await get('/ggplot2/ggplot2.pdf')).status, 404); // not a package
  assert.deepEqual(calls, ['/api/allowlist', '/dplyr/tidyr.pdf', '/dplyr/doc/dplyr.pdf']);
  assert.equal(points.length, 2);
});

test('passes invalid hashes to the backend', async () => {
  for (const hash of ['abc', 'X'.repeat(64), '806953e2f92f4109c6a0311430b922fb845888be513922ded23c323757a9c4fb0']) {
    assert.equal((await get(`/src/contrib/dplyr_1.1.4.tar.gz?sha256=${hash}`)).status, 302);
  }
  assert.deepEqual(calls.filter(x => x !== '/api/allowlist'), Array(3).fill('/src/contrib/dplyr_1.1.4.tar.gz'));
});

// The stats need the SQL API token, and the cache is filled in the background (waitUntil)
const statsEnv = { ...env, ANALYTICS_ACCOUNT: 'acc', ANALYTICS_TOKEN: 'secret' };
async function getStats(path, host = `test${universe}.r-universe.dev`) {
  const waits = [];
  const res = await worker.fetch(new Request(`https://${host}${path}`), statsEnv, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
}

test('serves downloads per package and platform', async () => {
  sqlRows = [
    { package: 'dplyr', platform: 'src', count: '3' },
    { package: 'dplyr', platform: 'windows', count: '5' },
    { package: 'tidyr', platform: 'linux', count: '10' }
  ];
  const res = await getStats('/cf/downloads?days=7');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-R-Universe-Edge'), 'stats');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(await res.json(), {
    universe: `test${universe}`, days: 7, downloads: 18, packages: [
      { package: 'tidyr', downloads: 10, platforms: { linux: 10 } },
      { package: 'dplyr', downloads: 8, platforms: { src: 3, windows: 5 } }
    ]
  });
  const [q] = sqlQueries;
  assert.equal(q.url, 'https://api.cloudflare.com/client/v4/accounts/acc/analytics_engine/sql');
  assert.equal(q.auth, 'Bearer secret');
  assert.match(q.sql, new RegExp(`index1 = 'test${universe}' AND blob2 = 'download'`));
  assert.match(q.sql, /INTERVAL '7' DAY/);
  assert.ok(!calls.includes('/cf/downloads')); // not from the backend
  assert.equal(points.length, 0); // and not counted
});

test('serves views of universe pages and package landing pages', async () => {
  sqlRows = [
    { type: 'universe', package: '', page: '/', count: '20' },
    { type: 'universe', package: '', page: '/builds', count: '5' },
    { type: 'universe', package: '', page: '/api/*', count: '1000' }, // not a page
    { type: 'package', package: 'dplyr', page: '/', count: '7' },
    { type: 'package', package: 'tidyr', page: '/', count: '9' }
  ];
  const res = await getStats('/CF/pageviews/');
  assert.deepEqual(await res.json(), {
    universe: `test${universe}`, days: 30, pageviews: 41, pages: { '/': 20, '/builds': 5 }, packages: [
      { package: 'tidyr', pageviews: 9 }, { package: 'dplyr', pageviews: 7 }
    ]
  });
  assert.match(sqlQueries[0].sql, /blob2 = 'package' AND blob5 = '\/'/);
});

test('caches stats per universe, type and days', async () => {
  for (const path of ['/cf/downloads', '/cf/downloads?days=30', '/cf/downloads?days=abc', '/cf/downloads?days=500']) {
    assert.equal((await getStats(path)).status, 200);
  }
  await getStats('/cf/pageviews');
  assert.deepEqual(sqlQueries.map(q => q.sql.match(/INTERVAL '(\d+)'/)[1]), ['30', '90', '30']);
  const res = await getStats('/cf/downloads', `other${universe}.r-universe.dev`);
  assert.equal((await res.json()).universe, `other${universe}`);
  assert.equal(sqlQueries.length, 4);
});

test('stats errors are not cached', async () => {
  sqlRows = () => new Response('rate limited', { status: 429 });
  const res = await getStats('/cf/downloads');
  assert.equal(res.status, 502);
  assert.match(await res.text(), /HTTP 429/);
  sqlRows = [];
  assert.equal((await getStats('/cf/downloads')).status, 200);
  assert.equal(sqlQueries.length, 2);
});

test('stats for unknown types, universes, and without a token', async () => {
  assert.equal((await getStats('/cf/other')).status, 404);
  assert.equal((await getStats('/cf/downloads/x')).status, 404);
  const res = await worker.fetch(new Request(`https://test${universe}.r-universe.dev/cf/pageviews`), env);
  assert.equal(res.status, 503);
  universe++;
  list = () => new Response('Error: No packages found for this owner or maintainer: test\n', { status: 404 });
  assert.equal((await getStats('/cf/downloads')).status, 404);
  assert.equal(sqlQueries.length, 0);
});

test('a package named cf is not shadowed by the stats', async () => {
  list.packages.push('cf');
  const res = await getStats('/cf/downloads');
  assert.equal(res.headers.get('X-R-Universe-Edge'), 'pass');
  assert.deepEqual(sqlQueries, []);
});

test('serves downloads of all universes on r-universe.dev', async () => {
  sqlRows = () => {
    const sql = sqlQueries.at(-1).sql;
    const data = sql.includes('GROUP BY platform') ? [{ platform: 'src', count: '3' }, { platform: 'linux', count: '10' }]
      : sql.includes('DISTINCT') ? [{ count: '2' }]
      : sql.includes('GROUP BY universe, package') ? [{ universe: 'cran', package: 'dplyr', count: '8' }, { universe: 'jeroen', package: 'v8', count: '5' }]
      : [{ universe: 'cran', count: '8' }, { universe: 'jeroen', count: '5' }];
    return Response.json({ data });
  };
  const res = await getStats('/cf/downloads?days=7&top=2', 'r-universe.dev');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-R-Universe-Edge'), 'stats');
  assert.deepEqual(await res.json(), {
    days: 7, top: 2, downloads: 13, universes: 2, platforms: { linux: 10, src: 3 },
    top_universes: [{ universe: 'cran', downloads: 8 }, { universe: 'jeroen', downloads: 5 }],
    top_packages: [{ universe: 'cran', package: 'dplyr', downloads: 8 }, { universe: 'jeroen', package: 'v8', downloads: 5 }]
  });
  assert.equal(sqlQueries.length, 4);
  assert.ok(sqlQueries.every(q => !q.sql.includes('index1') && /INTERVAL '7' DAY/.test(q.sql)));
  assert.equal(sqlQueries.filter(q => q.sql.includes('LIMIT 2 ')).length, 2);

  // Cached per days and top
  await getStats('/cf/downloads?top=2&days=7', 'r-universe.dev');
  assert.equal(sqlQueries.length, 4);
  await getStats('/cf/downloads?days=7&top=5000', 'r-universe.dev');
  assert.equal(sqlQueries.filter(q => q.sql.includes('LIMIT 1000 ')).length, 2);
  assert.equal(points.length, 0); // not counted
});

test('serves views of the pages of r-universe.dev', async () => {
  sqlRows = [
    { page: '/', count: '20' },
    { page: '/search', count: '5' },
    { page: '/api/*', count: '1000' } // not a page
  ];
  const res = await getStats('/cf/pageviews?top=3', 'r-universe.dev');
  assert.deepEqual(await res.json(), { days: 30, pageviews: 25, pages: { '/': 20, '/search': 5 } });
  assert.match(sqlQueries[0].sql, /index1 = '_global' AND blob2 = 'universe'/);
  assert.equal((await getStats('/cf/other', 'r-universe.dev')).status, 404);
});

// Deployments, as sent by actions/deploy-packages/deploy-r2.sh
const SHA = '806953e2f92f4109c6a0311430b922fb845888be513922ded23c323757a9c4fb';
async function sendDeploy(method, path, { headers = {}, body } = {}) {
  const waits = [];
  const request = new Request(`https://test${universe}.r-universe.dev${path}`, { method, headers, body });
  const res = await worker.fetch(request, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
}
const COLUMNS = ['time', 'universe', 'package', 'version', 'pkgtype', 'rversion', 'arch', 'distro',
  'checkstatus', 'sha256', 'run_id', 'buildurl', 'status'];
function savedRows() {
  return deployRows.map(({ sql, values }) => {
    assert.match(sql, /^INSERT INTO deployments/);
    const row = Object.fromEntries(COLUMNS.map((name, i) => [name, values[i]]));
    assert.ok(Math.abs(row.time - Date.now() / 1000) < 5);
    delete row.time;
    return row;
  });
}
function builder(type, check = 'OK') {
  return {
    'Builder-Check': check, 'Builder-Distro': type === 'linux' ? 'noble' : '',
    'Builder-Buildurl': `https://github.com/r-universe/test${universe}/actions/runs/123456`
  };
}

test('records deployments of package files, with R version and architecture of binaries', async () => {
  const built = {
    src: undefined,
    win: { R: '4.5.1', Platform: 'x86_64-w64-mingw32', Date: 'x', OStype: 'windows' },
    mac: 'R 4.4.2; aarch64-apple-darwin20; 2026-10-24 12:00:00 UTC; unix', // as a string
    linux: { R: '4.6.0', Platform: '', OStype: 'unix' }, // no compiled code
    wasm: { R: '4.5.1', Platform: 'wasm32-unknown-emscripten' }
  };
  for (const type of Object.keys(built)) {
    deployResponse = () => Response.json({ Package: 'dplyr', Built: built[type] });
    const headers = builder(type, type === 'wasm' ? '' : 'WARNING');
    const res = await sendDeploy('PUT', `/api/packages/dplyr/1.1.4/${type}/${SHA}`, { headers, body: 'downloadurl=x' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-R-Universe-Edge'), 'deploy');
    assert.equal((await res.json()).Package, 'dplyr'); // passed unchanged
  }
  const name = `test${universe}`;
  const row = { universe: name, package: 'dplyr', version: '1.1.4', distro: null, checkstatus: 'WARNING', sha256: SHA, run_id: 123456, buildurl: null, status: 200 };
  assert.deepEqual(savedRows(), [
    { ...row, pkgtype: 'src', rversion: null, arch: null },
    { ...row, pkgtype: 'win', rversion: '4.5.1', arch: 'x86_64' },
    { ...row, pkgtype: 'mac', rversion: '4.4.2', arch: 'aarch64' },
    { ...row, pkgtype: 'linux', rversion: '4.6.0', arch: 'all', distro: 'noble' },
    { ...row, pkgtype: 'wasm', rversion: '4.5.1', arch: 'wasm32', checkstatus: null }
  ]);
  assert.equal(calls.filter(x => x.startsWith('PUT ')).length, 5);
  assert.ok(!calls.includes('/api/allowlist'));
  assert.equal(points.length, 0); // not counted as hits
});

test('records failed deployments and build failures', async () => {
  deployResponse = () => new Response('Error: invalid package\n', { status: 500 });
  const res = await sendDeploy('PUT', `/api/packages/dplyr/1.1.4/win/${SHA}`, { headers: builder('win') });
  assert.equal(res.status, 500);
  assert.equal(await res.text(), 'Error: invalid package\n');

  deployResponse = () => Response.json({ Package: 'dplyr', _type: 'failure' });
  const form = new URLSearchParams({
    'Builder-Distro': 'noble', 'Builder-Host': 'GitHub-Actions',
    'Builder-Buildurl': `https://github.com/r-universe/test${universe}/actions/runs/789`
  });
  assert.equal((await sendDeploy('POST', '/api/packages/dplyr/1.1.4/failure', { body: form })).status, 200);

  // the server is unreachable
  deployResponse = () => { throw new TypeError('fetch failed'); };
  await assert.rejects(sendDeploy('PUT', `/api/packages/tidyr/1.3.1/src/${SHA}`, { headers: builder('src') }));

  const row = { universe: `test${universe}`, package: 'dplyr', version: '1.1.4', rversion: null, arch: null, buildurl: null };
  assert.deepEqual(savedRows(), [
    { ...row, pkgtype: 'win', distro: null, checkstatus: 'OK', sha256: SHA, run_id: 123456, status: 500 },
    { ...row, pkgtype: 'failure', distro: 'noble', checkstatus: null, sha256: null, run_id: 789, status: 200 },
    { ...row, package: 'tidyr', version: '1.3.1', pkgtype: 'src', distro: null, checkstatus: 'OK', sha256: SHA, run_id: 123456, status: 0 }
  ]);
});

test('keeps the buildurl of runs in other repositories', async () => {
  deployResponse = () => Response.json({});
  const buildurl = 'https://github.com/someone/fork/actions/runs/42';
  await sendDeploy('PUT', `/api/packages/dplyr/1.1.4/src/${SHA}`, { headers: { 'Builder-Buildurl': buildurl } });
  await sendDeploy('PUT', `/api/packages/dplyr/1.1.4/src/${SHA}`, { headers: { 'Builder-Buildurl': 'local build' } });
  await sendDeploy('PUT', `/api/packages/dplyr/1.1.4/src/${SHA}`);
  assert.deepEqual(savedRows().map(x => [x.run_id, x.buildurl, x.checkstatus]), [
    [42, buildurl, null], [null, 'local build', null], [null, null, null]
  ]);
});

test('passes other uploads without recording them', async () => {
  deployResponse = () => Response.json({});
  for (const [method, path] of [['POST', '/api/progress/dplyr'], ['PUT', '/api/packages/dplyr/1.1.4/src'],
    ['PUT', '/api/packages/dplyr/1.1.4/other/' + SHA], ['POST', `/api/packages/dplyr/1.1.4/src/${SHA}`],
    ['DELETE', '/api/packages/dplyr']]) {
    const res = await sendDeploy(method, path, { body: method === 'DELETE' ? undefined : 'x' });
    assert.equal(res.headers.get('X-R-Universe-Edge'), null, path);
  }
  assert.equal(deployRows.length, 0);
});
