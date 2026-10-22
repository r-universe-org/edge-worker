import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// A fake backend: /api/allowlist returns the allowlist, other pages return 200 (downloads a 302)
let list, calls, points;
let listOptions;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  calls.push(url.pathname);
  if (url.pathname === '/api/allowlist') {
    listOptions = init;
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
});

const env = { HITS: { writeDataPoint: (point) => points.push(point) } }; // fake Analytics Engine
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

test('caches the allowlist at the edge, but not errors', async () => {
  await get('/');
  const ttl = listOptions.cf.cacheTtlByStatus;
  assert.equal(ttl['200-299'], 300);
  assert.equal(ttl['404'], 300);
  assert.ok(ttl['300-403'] < 0 && ttl['405-599'] < 0);
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

test('keeps the allowlist for 5 minutes, but retries a failure after 1 minute', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const loads = () => calls.filter(x => x === '/api/allowlist').length;
  await get('/');
  t.mock.timers.tick(299 * 1000);
  await get('/');
  assert.equal(loads(), 1);
  t.mock.timers.tick(2 * 1000);
  await get('/');
  assert.equal(loads(), 2);

  list = () => new Response('Bad gateway', { status: 502 });
  t.mock.timers.tick(301 * 1000);
  await get('/'); // fails
  t.mock.timers.tick(59 * 1000);
  await get('/');
  assert.equal(loads(), 3);
  t.mock.timers.tick(2 * 1000);
  await get('/');
  assert.equal(loads(), 4);
});

test('passes other hosts and methods without loading the allowlist', async () => {
  await get('/wp-admin', 'GET', 'r-universe.dev');
  await get('/wp-admin', 'POST');
  assert.deepEqual(calls, ['/wp-admin', '/wp-admin']);
});

test('counts hits of packages, downloads, and universe pages', async () => {
  await get('/dplyr');
  await get('/DPLYR/doc/manual.html');
  await get('/src/contrib/dplyr_1.1.4.tar.gz');
  await get('/bin/windows/contrib/4.5/data.table_1.16.0.zip');
  await get('/bin/macosx/big-sur-arm64/contrib/4.5/RAppArmor_3.2.tgz');
  await get('/bin/linux/noble-x86_64/4.5/src/contrib/tidyr_1.3.1.tar.gz');
  await get('/src/contrib/missing_1.0.tar.gz');
  await get('/src/contrib/PACKAGES.gz');
  await get('/builds');
  await get('/');
  await get('/dplyr', 'HEAD'); // only GET
  await get('/wp-admin'); // rejected
  const name = `test${universe}`;
  assert.deepEqual(points.map(x => x.blobs), [
    [name, 'package', 'dplyr', '', ''],
    [name, 'package', 'dplyr', '', ''],
    [name, 'download', 'dplyr', '1.1.4', 'src'],
    [name, 'download', 'data.table', '1.16.0', 'windows'],
    [name, 'download', 'rapparmor', '3.2', 'macosx'],
    [name, 'download', 'tidyr', '1.3.1', 'linux'],
    [name, 'download', 'missing', '1.0', 'src'],
    [name, 'universe', '', '', '/src'],
    [name, 'universe', '', '', '/builds'],
    [name, 'universe', '', '', '/']
  ]);
  assert.deepEqual(points.map(x => x.doubles[0]), [200, 200, 302, 302, 302, 302, 404, 200, 200, 200]);
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

test('passes invalid hashes to the backend', async () => {
  for (const hash of ['abc', 'X'.repeat(64), '806953e2f92f4109c6a0311430b922fb845888be513922ded23c323757a9c4fb0']) {
    assert.equal((await get(`/src/contrib/dplyr_1.1.4.tar.gz?sha256=${hash}`)).status, 302);
  }
  assert.deepEqual(calls.filter(x => x !== '/api/allowlist'), Array(3).fill('/src/contrib/dplyr_1.1.4.tar.gz'));
});
