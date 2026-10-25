// Every package deployment, in the D1 database r-universe-deployments (binding DEPLOYS), see README.md.
// Deployments come from actions/deploy-packages/deploy-r2.sh:
//   PUT  /api/packages/{package}/{version}/{pkgtype}/{sha256}  a package file, with Builder-* headers
//   POST /api/packages/{package}/{version}/failure             a failed build, with a form of Builder-* fields
// The request and the response pass unchanged; the row is written in the background. The R version
// and architecture of binaries come from the response of the server, which reads them from the
// Built field of the binary's DESCRIPTION.

const DEPLOY = /^\/api\/packages\/([^/]+)\/([^/]+)\/(src|win|mac|linux|wasm)\/([0-9a-f]{64})\/?$/;
const FAILURE = /^\/api\/packages\/([^/]+)\/([^/]+)\/failure\/?$/;

// https://github.com/r-universe/{universe}/actions/runs/{run_id}, so only the run_id is stored
const BUILDURL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/;

const INSERT = `INSERT INTO deployments (time, universe, package, version, pkgtype, rversion, arch,
  distro, checkstatus, sha256, run_id, buildurl, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
  let built = {};
  try {
    built = parseBuilt(response && (await response.json()).Built);
  } catch {} // not json: no R version and architecture
  try {
    await env.DEPLOYS?.prepare(INSERT).bind(row.time, row.universe, row.package, row.version, row.pkgtype,
      built.rversion ?? null, built.arch ?? null, row.distro, row.checkstatus, row.sha256, row.run_id,
      row.buildurl, row.status).run();
  } catch (e) {
    console.log(`Failed to save deployment of ${row.universe}/${row.package}: ${e.message}`);
  }
}

// Built is {R, Platform, ...}, or a string 'R 4.5.1; aarch64-apple-darwin20; ...'. Without a platform
// the package has no compiled code: 'all' architectures, like the server does.
function parseBuilt(built) {
  if (typeof built === 'string') {
    const [R, Platform] = built.replace(/^R /, '').split(/;\s*/);
    built = { R, Platform };
  }
  if (!built?.R) {
    return {};
  }
  return { rversion: built.R, arch: built.Platform ? built.Platform.split('-')[0] : 'all' };
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
