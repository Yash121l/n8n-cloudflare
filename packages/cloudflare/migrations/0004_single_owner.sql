-- Two concurrent owner setups must not both succeed. The database enforces one owner.
CREATE UNIQUE INDEX user_single_owner ON user (roleSlug) WHERE roleSlug = 'global:owner';
