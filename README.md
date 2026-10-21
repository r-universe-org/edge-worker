# r-universe-edge

Cloudflare worker in front of `{universe}.r-universe.dev`. All code is in `src/index.js`.
It does two things, and passes everything else to the backend unchanged:

 - **Reject pages that do not exist**, without the backend. The first path segment must be
   in the allowlist of the universe: one of its packages, or a universe page (`/`, `/api`,
   `/src`, `/bin`, `/builds`, `/card.png`, ...). The allowlist is lowercase, and matching is
   case insensitive (the frontend redirects other cases of package names). Everything on a
   universe that does not exist gets a 404. This removes the noise from security scanners
   and scripts that try random paths.
 - **Count hits** per universe and package, see below.
 - **Redirect downloads by hash**: requests with a `?sha256={hash}` parameter (64 hex
   characters) get a 301 to `https://r2.ropensci.org/{hash}`, without the allowlist or the
   backend. This relieves the backend of the many concurrent package downloads (it replaces
   the redirect rule in Cloudflare that did this before the worker). Other values of the
   parameter go to the backend as usual.

The allowlist comes from `/api/allowlist` of the universe (for example
https://jeroen.r-universe.dev/api/allowlist), with separate lists of `packages` and
`universe` pages. It is kept in memory for a minute. If it can not be loaded, all requests
are passed through (for that minute), and not counted. Other hosts (`r-universe.dev`, vhosts
like `*.ropensci.org`) and methods other than GET/HEAD are always passed through.

To see what the worker did, responses for GET/HEAD requests on a universe have a header
`X-R-Universe-Edge`: `redirect` (download by hash), `rejected` (404 from the worker), `pass`
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
| `blob5`   | for downloads the platform (`src`, `windows`, `macosx`, `linux`, `emscripten`), for universe pages the page (`/`, `/builds`, `/api`, ...) |
| `double1` | HTTP status of the response |

The types are:

 - `download`: a package file, `/src/contrib/{package}_{version}.tar.gz` or
   `/bin/{platform}/.../{package}_{version}.{zip,tgz,tar.gz}`. A successful download is a
   redirect to the file storage: 302 from the backend, or 301 for downloads by hash.
 - `package`: a package page, e.g. `/dplyr` or `/dplyr/doc/manual.html`.
 - `universe`: any other page of the universe, e.g. `/builds`, `/packages`, `/api/...`, and
   the repository indexes such as `/src/contrib/PACKAGES.gz`.

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

Use `blob2 = 'package'` for views of package pages, group by `blob1` and `blob2` for hits per
universe and type, or by `blob5` for downloads per platform.

## Deploy

```sh
npx wrangler deploy
```

The worker must run on a *route* (see `wrangler.toml`), not a custom domain: requests
from the worker to its own zone (for `/api/allowlist` and the pages) then go to the origin,
instead of to the worker again. Workers are billed per request: all universe traffic goes
through the worker.

## Test

```sh
npm test
```

The tests use a fake backend and run in Node.
