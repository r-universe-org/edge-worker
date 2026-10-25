-- When the package was created, from the server's response: Built.Date of binaries, Packaged.Date of
-- source packages (unix seconds). Unlike `time`, the deployment, which can be much later (retries).
ALTER TABLE deployments ADD COLUMN created INTEGER;
