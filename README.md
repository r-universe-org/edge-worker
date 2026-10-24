# r-universe-edge

This is an *optional* worker that runs on the `r-universe.dev` domains to reduce stress on our server and collect some stats. Enabling it will:

 - **Reject pages and universes that do not exist** to block noise from security scanners
 - **Redirect sha256 requests directly to R2** without revalidation to speed up package downloads
 - **Count download hits** per universe and package, see below.
 - **Expose stats endpoits** stats `/cf/downloads` and `/cf/pageviews`

The worker can be enabled and disabled for certain routes in cloudflare. Everything in R-universe should still work when the router is disabled.

## Allow lists

The backend server exposes allow lists about valid top level directories, e.g.

 - https://r-universe.dev/api/allowlist
 - https://jeroen.r-universe.dev/api/allowlist

The idea is that these are highly cachable and can be used to prefilter requests in the edge.

To see what the worker did, responses for GET/HEAD requests on a universe have a header
`X-R-Universe-Edge` (also `blocked` for blocked crawlers and bots, on any request): `redirect` (download by hash), `rejected` (404 from the worker), `pass`
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

For example https://jeroen.r-universe.dev/cf/downloads. `days` is 1 to 90 (default 30).
Package names are lowercase. Responses are cached at the edge for an hour (per data center),
also in browsers, and allow CORS. Errors are not cached. If a universe has a package named
`cf`, its page is served instead.

The SQL API requires an API token with *Account Analytics: Read*, set as a secret of the
worker: `npx wrangler secret put ANALYTICS_TOKEN`. The account is the variable
`ANALYTICS_ACCOUNT` in `wrangler.toml`. Without them the endpoints return 503.

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
