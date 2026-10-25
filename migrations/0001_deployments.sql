-- Every package deployment that goes through the worker, see README.md. Apply with:
-- npx wrangler d1 migrations apply r-universe-deployments --remote
CREATE TABLE deployments (
  id          INTEGER PRIMARY KEY,
  time        INTEGER NOT NULL, -- unix seconds
  universe    TEXT NOT NULL,
  package     TEXT NOT NULL,
  version     TEXT NOT NULL,
  pkgtype     TEXT NOT NULL,    -- src, win, mac, linux, wasm, or failure (a failed build)
  rversion    TEXT,             -- binaries: Built.R from the server's response, e.g. 4.5.1
  arch        TEXT,             -- binaries: x86_64, aarch64, wasm32, or all (no compiled code)
  distro      TEXT,             -- Builder-Distro, e.g. noble for linux
  checkstatus TEXT,             -- Builder-Check (none for wasm and failures)
  sha256      TEXT,             -- the file (none for failures)
  run_id      INTEGER,          -- the GitHub Actions run of https://github.com/r-universe/{universe}
  buildurl    TEXT,             -- only if it is not the run of that repository
  status      INTEGER NOT NULL  -- HTTP status of the server's response, 0 if it failed
);
CREATE INDEX deployments_package ON deployments (universe, package, time);
CREATE INDEX deployments_time ON deployments (time);
