-- For /cf/deployments without a package: the latest deployments of a universe
CREATE INDEX deployments_universe ON deployments (universe, time);
