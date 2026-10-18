-- Project scoped variables. projectId NULL means a global variable, so a key is unique per scope.
CREATE TABLE variables_new (
	id TEXT PRIMARY KEY,
	key TEXT NOT NULL,
	type TEXT NOT NULL DEFAULT 'string',
	value TEXT,
	projectId TEXT REFERENCES project (id) ON DELETE CASCADE
);
INSERT INTO variables_new (id, key, type, value) SELECT id, key, type, value FROM variables;
DROP TABLE variables;
ALTER TABLE variables_new RENAME TO variables;
CREATE UNIQUE INDEX idx_variables_key_scope ON variables (key, COALESCE(projectId, ''));
