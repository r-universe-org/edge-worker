// Every package deployment, in the D1 database r-universe-deployments (binding DEPLOYS), see README.md.
// Deployments come from actions/deploy-packages/deploy-r2.sh:
//   PUT  /api/packages/{package}/{version}/{pkgtype}/{sha256}  a package file, with Builder-* headers
//   POST /api/packages/{package}/{version}/failure             a failed build, with a form of Builder-* fields
// The request and the response pass unchanged; the row is written in the background. The R version,
// architecture and creation date come from the response of the server, which reads them from the
// DESCRIPTION: Built for binaries, Packaged for source packages.

const DEPLOY = /^\/api\/packages\/([^/]+)\/([^/]+)\/(src|win|mac|linux|wasm)\/([0-9a-f]{64})\/?$/;
const FAILURE = /^\/api\/packages\/([^/]+)\/([^/]+)\/failure\/?$/;

// https://github.com/r-universe/{universe}/actions/runs/{run_id}, so only the run_id is stored
const BUILDURL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/;

const INSERT = `INSERT INTO deployments (time, universe, package, version, pkgtype, rversion, arch,
  created, distro, checkstatus, sha256, run_id, buildurl, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function isDeploy(request, url) {
  return (request.method === 'PUT' && DEPLOY.test(url.pathname)) ||
    (request.method === 'POST' && FAILURE.test(url.pathname));
}

export async function deploy(request, env, ctx, universe, url) {
  const file = url.pathname.match(DEPLOY);
  const [, pkg, version, pkgtype, sha256] = file ?? [...url.pathname.match(FAILURE), 'failure', null];
  const fields = file ? request.headers : await readForm(request.clone());
  const [run_id, buildurl] = parseBuildurl(fields.get('Builder-Buildurl'), universe);
  const row = {
    time: Math.floor(Date.now() / 1000), universe, package: decodeURIComponent(pkg),
    version: decodeURIComponent(version), pkgtype, distro: fields.get('Builder-Distro') || null,
    checkstatus: fields.get('Builder-Check') || null, sha256, run_id, buildurl
  };
  let response;
  try {
    response = await fetch(request);
  } catch (e) {
    ctx?.waitUntil(save(env, { ...row, status: 0 }));
    throw e;
  }
  ctx?.waitUntil(save(env, { ...row, status: response.status }, response.ok ? response.clone() : null));
  return response;
}

async function save(env, row, response) {
  let pkg = {};
  try {
    pkg = parseDescription(response && await response.json());
  } catch {} // not json: no R version, architecture and creation date
  try {
    await env.DEPLOYS?.prepare(INSERT).bind(row.time, row.universe, row.package, row.version, row.pkgtype,
      pkg.rversion ?? null, pkg.arch ?? null, pkg.created ?? null, row.distro, row.checkstatus, row.sha256,
      row.run_id, row.buildurl, row.status).run();
  } catch (e) {
    console.log(`Failed to save deployment of ${row.universe}/${row.package}: ${e.message}`);
  }
}

// From the DESCRIPTION of the package, as the server does (get_created and parse_architecture in
// express-frontend routes/packages.js). Binaries: Built is {R, Platform, Date, OStype}, or a string
// 'R 4.5.1; aarch64-apple-darwin20; 2026-10-25 13:02:11 UTC; unix'. Without a platform the package
// has no compiled code: 'all' architectures. Source packages: Packaged is {Date, User}, or a string.
function parseDescription(description) {
  let { Built: built, Packaged: packaged } = description ?? {};
  if (typeof built === 'string') {
    const [R, Platform, Date] = built.replace(/^R /, '').split(/;\s*/);
    built = { R, Platform, Date };
  }
  if (typeof packaged === 'string') {
    packaged = { Date: packaged.split(';')[0] };
  }
  const created = Date.parse(built?.Date ?? packaged?.Date);
  return {
    rversion: built?.R,
    arch: built?.R ? built.Platform ? built.Platform.split('-')[0] : 'all' : undefined,
    created: Number.isNaN(created) ? undefined : Math.floor(created / 1000)
  };
}

// [run_id, buildurl]: the buildurl only if it is not a run of https://github.com/r-universe/{universe}
function parseBuildurl(buildurl, universe) {
  const run = buildurl?.match(BUILDURL);
  if (!run) {
    return [null, buildurl || null];
  }
  return [Number(run[2]), run[1].toLowerCase() === `r-universe/${universe}` ? null : buildurl];
}

async function readForm(request) {
  try {
    return new URLSearchParams(await request.text());
  } catch {
    return new URLSearchParams();
  }
}

// For /cf/deployments (see stats.js): {deployments: [...]}, newest first, of the universe or one of
// its packages (the exact name), in the last `days` days.
export async function listDeployments(env, universe, { days, limit, package: pkg }) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const { results } = await env.DEPLOYS.prepare(`SELECT time, package, version, pkgtype, rversion, arch,
    created, distro, checkstatus, sha256, run_id, buildurl, status FROM deployments WHERE universe = ? AND time > ?
    ${pkg ? 'AND package = ?' : ''} ORDER BY time DESC LIMIT ?`)
    .bind(...[universe, since, pkg, limit].filter(x => x !== undefined)).all();
  return {
    deployments: results.map(r => ({
      time: isoDate(r.time), package: r.package, version: r.version, pkgtype: r.pkgtype, rversion: r.rversion,
      arch: r.arch, created: isoDate(r.created), distro: r.distro, checkstatus: r.checkstatus, sha256: r.sha256,
      buildurl: r.buildurl ?? (r.run_id ? `https://github.com/r-universe/${universe}/actions/runs/${r.run_id}` : null),
      status: r.status
    }))
  };
}

function isoDate(seconds) {
  return seconds == null ? null : new Date(seconds * 1000).toISOString();
}
