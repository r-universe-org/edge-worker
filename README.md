# r-universe-edge

This is an *optional* worker that runs on the `r-universe.dev` domains to reduce stress on our server and collect some stats. Enabling it will:

 - **Reject pages and universes that do not exist** to block noise from security scanners
 - **Redirect sha256 requests directly to R2** without revalidation to speed up package downloads
 - **Redirect CRAN-style manual urls** `/{package}/{package}.pdf` to `/{package}/doc/manual.pdf`, which search engines request a lot
 - **Count download hits** per universe and package, and page hits on `r-universe.dev`, see below.
 - **Expose stats endpoits** stats `/cf/downloads` and `/cf/pageviews`
 - **Record every package deployment** in a D1 database, see below.

The worker can be enabled and disabled for certain routes in cloudflare. Everything in R-universe should still work when the router is disabled.

## Allow lists

The backend server exposes allow lists about valid top level directories, e.g.

 - https://r-universe.dev/api/allowlist
 - https://jeroen.r-universe.dev/api/allowlist

The idea is that these are highly cachable and can be used to prefilter requests in the edge.

To see what the worker did, responses for GET/HEAD requests on a universe have a header
`X-R-Universe-Edge` (also `blocked` for blocked crawlers and bots, on any request): `redirect` (download by hash or manual), `rejected` (404 from the worker), `pass`
(allowed, from the backend), or `unchecked` (from the backend, the allowlist could not be
loaded). Responses without the header did not go through the worker.

## Hits

For each GET request that is not rejected, the worker writes a data point to the
[Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
dataset `r_universe_hits` (binding `HITS` in `wrangler.toml`):

| column    | value |
|-----------|-------|
| `index1`  | universe (the sampling key) |
| `blob1`   | universe |
| `blob2`   | type: `download`, `package` or `universe` (see below) |
| `blob3`   | package (lowercase), empty for universe pages |
| `blob4`   | version, for downloads only |
| `blob5`   | for downloads the platform (`src`, `windows`, `macosx`, `linux`, `emscripten`), for packages and universe pages the page (see below) |
| `double1` | HTTP status of the response |

The types are:

 - `download`: a package file, `/src/contrib/{package}_{version}.tar.gz` or
   `/bin/{platform}/.../{package}_{version}.{zip,tgz,tar.gz}`. A successful download is a
   redirect to the file storage: 302 from the backend, or 301 for downloads by hash.
 - `package`: a package page. The page is `/` for the landing page (`/dplyr`), otherwise
   the first part of the path below the package, e.g. `/doc` for `/dplyr/doc/manual.html`
   or `/badges` for `/dplyr/badges/version`.
 - `universe`: any other page of the universe. The page is the page itself, e.g. `/` for the
   homepage, `/builds`, `/packages` or `/api`, or with `/*` for anything below it, e.g.
   `/api/*` for the API and `/src/*` for the repository indexes such as
   `/src/contrib/PACKAGES.gz`.

Hits on `r-universe.dev` itself are recorded as the universe `_global`, always with type
`universe` (e.g. `/search`, or `/api/*`).

Data is kept for three months. At high volume Analytics Engine samples data points, so
count with `SUM(_sample_interval)` rather than `COUNT()`. Query with the
[SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/), using an
API token with *Account Analytics: Read*. For example the most downloaded packages:

```sh
curl "https://api.cloudflare.com/client/v4/accounts/3fcdf4a2e34a7a2e74fc8686b68acea1/analytics_engine/sql" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --data "SELECT blob1 AS universe, blob3 AS package, SUM(_sample_interval) AS downloads
    FROM r_universe_hits WHERE timestamp > NOW() - INTERVAL '7' DAY
      AND blob2 = 'download' AND double1 < 400
    GROUP BY universe, package ORDER BY downloads DESC LIMIT 50 FORMAT JSON"
```

Use `blob2 = 'package' AND blob5 = '/'` for views of package landing pages, group by `blob1` and `blob2` for hits per
universe and type, or by `blob5` for downloads per platform.

## Stats

The hits of a universe are public on two endpoints of the worker (in `src/stats.js`), which
query the SQL API, so that the frontend and other clients need no token:

 - `/cf/downloads?days=30`: downloads per package and platform, as above.
 - `/cf/pageviews?days=30`: views of the universe pages that are html pages (`/`, `/builds`,
   `/packages`, `/badges`, `/api`, `/datasets`, `/contributors`, `/articles`) and of the
   landing pages of the packages, with status 200 or 304.

On `r-universe.dev` the same endpoints show stats of the whole site:

 - `/cf/downloads?days=30&top=100`: downloads of all universes: the total, the number of
   universes with downloads, downloads per platform, and the `top` (1 to 1000) universes
   (`top_universes`) and packages (`top_packages`, with their universe).
 - `/cf/pageviews?days=30`: views of the html pages of `r-universe.dev` (`/`, `/search`,
   `/packages`, `/organizations`, etc), with status 200 or 304.

For example https://jeroen.r-universe.dev/cf/downloads or https://r-universe.dev/cf/downloads?top=10. `days` is 1 to 90 (default 30).
Package names are lowercase. Responses are cached at the edge for an hour (per data center),
also in browsers, and allow CORS. Errors are not cached. If a universe has a package named
`cf`, its page is served instead.

The SQL API requires an API token with *Account Analytics: Read*, set as a secret of the
worker: `npx wrangler secret put ANALYTICS_TOKEN`. The account is the variable
`ANALYTICS_ACCOUNT` in `wrangler.toml`. Without them the endpoints return 503.

## Deployments

Every package deployment (in `src/deploy.js`) is a row in the table `deployments` of the
[D1](https://developers.cloudflare.com/d1/) database `r-universe-deployments` (binding `DEPLOYS`),
a permanent record, unlike the hits. Deployments come from `actions/deploy-packages/deploy-r2.sh`:

 - `PUT /api/packages/{package}/{version}/{pkgtype}/{sha256}`: a package file, with `Builder-*` headers.
 - `POST /api/packages/{package}/{version}/failure`: a failed build, with a form of `Builder-*` fields.

The request and response pass unchanged (with `X-R-Universe-Edge: deploy`), and the row is written
in the background. Every attempt is a row, so retries and failed deployments are recorded too:

| column        | value |
|---------------|-------|
| `time`        | unix seconds |
| `universe`    | from the hostname |
| `package`, `version` | from the url |
| `pkgtype`     | `src`, `win`, `mac`, `linux`, `wasm`, or `failure` |
| `rversion`    | binaries: `Built.R` from the server's response, e.g. `4.5.1` (the deploy does not send it) |
| `arch`        | binaries: from `Built.Platform`: `x86_64`, `aarch64`, `emscripten` (wasm), or `all` (no compiled code) |
| `distro`      | `Builder-Distro`, e.g. `noble` for linux |
| `checkstatus` | `Builder-Check`, none for wasm and failures |
| `sha256`      | the file, none for failures |
| `run_id`      | the run in `https://github.com/r-universe/{universe}/actions/runs/{run_id}` |
| `buildurl`    | only if `Builder-Buildurl` is not a run of that repository |
| `status`      | HTTP status of the server's response, 0 if the server could not be reached |

Store R versions rather than release names: whether 4.5 is r-release or r-oldrel depends on the date.
Query with SQL, for example the latest deployments of a package:

```sh
npx wrangler d1 execute r-universe-deployments --remote --command \
  "SELECT datetime(time, 'unixepoch'), pkgtype, rversion, arch, checkstatus, status FROM deployments
   WHERE universe = 'jeroen' AND package = 'jsonlite' ORDER BY time DESC LIMIT 20"
```

The schema is in `migrations/`: add a file to change it (new columns should be nullable), and apply
it with `npx wrangler d1 migrations apply r-universe-deployments --remote`. The wrangler login has no
access to D1: these commands need `CLOUDFLARE_API_TOKEN` with D1 access (such as the token of the
`cf` CLI). At about 58,000 deployments a day the table grows ~5 GB a year; a D1 database holds at
most 10 GB, so older rows will need archiving after about two years.

## Deploy

```sh
npx wrangler deploy
```

The worker must run on a *route* (see `wrangler.toml`), not a custom domain: requests
from the worker to its own zone (for `/api/allowlist` and the pages) then go to the origin,
instead of to the worker again. Workers are billed per request: all traffic on universes and
on `r-universe.dev` goes through the worker.

## Test

```sh
npm test
```

The tests use a fake backend and run in Node.
