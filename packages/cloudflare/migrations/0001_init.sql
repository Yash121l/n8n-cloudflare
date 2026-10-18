-- Mirrors n8n's SQLite tables that the Cloudflare runtime uses.
-- Timestamps are ISO-8601 strings, JSON is stored as TEXT.
-- Execution payloads live in R2 (executions/<id>.json), not here.

CREATE TABLE user (
	id TEXT PRIMARY KEY,
	email TEXT UNIQUE,
	firstName TEXT,
	lastName TEXT,
	password TEXT,
	personalizationAnswers TEXT,
	settings TEXT,
	roleSlug TEXT NOT NULL DEFAULT 'global:member',
	disabled INTEGER NOT NULL DEFAULT 0,
	mfaEnabled INTEGER NOT NULL DEFAULT 0,
	mfaSecret TEXT,
	mfaRecoveryCodes TEXT NOT NULL DEFAULT '',
	lastActiveAt TEXT,
	createdAt TEXT NOT NULL,
	updatedAt TEXT NOT NULL
);

CREATE TABLE project (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	type TEXT NOT NULL,
	icon TEXT,
	description TEXT,
	creatorId TEXT REFERENCES user (id) ON DELETE SET NULL,
	createdAt TEXT NOT NULL,
	updatedAt TEXT NOT NULL
);

CREATE TABLE project_relation (
	projectId TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	userId TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
	role TEXT NOT NULL,
	createdAt TEXT NOT NULL,
	updatedAt TEXT NOT NULL,
	PRIMARY KEY (projectId, userId)
);
CREATE INDEX idx_project_relation_user ON project_relation (userId);

CREATE TABLE folder (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	parentFolderId TEXT REFERENCES folder (id) ON DELETE CASCADE,
	projectId TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	createdAt TEXT NOT NULL,
	updatedAt TEXT NOT NULL
);

CREATE TABLE workflow_entity (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT,
	active INTEGER NOT NULL DEFAULT 0,
	isArchived INTEGER NOT NULL DEFAULT 0,
	nodes TEXT NOT NULL,
	connections TEXT NOT NULL,
	settings TEXT,
	staticData TEXT,
	meta TEXT,
	pinData TEXT,
	nodeGroups TEXT NOT NULL DEFAULT '[]',
	versionId TEXT NOT NULL,
	activeVersionId TEXT,
	versionCounter INTEGER NOT NULL DEFAULT 1,
	triggerCount INTEGER NOT NULL DEFAULT 0,
	parentFolderId TEXT REFERENCES folder (id) ON DELETE CASCADE,
	createdAt TEXT NOT NULL,
	updatedAt TEXT NOT NULL
);

CREATE TABLE workflow_history (
	versionId TEXT PRIMARY KEY,
	workflowId TEXT NOT NULL REFERENCES workflow_entity (id) ON DELETE CASCADE,
	nodes TEXT NOT NULL,
	connections TEXT NOT NULL,
	nodeGroups TEXT NOT NULL DEFAULT '[]',
	authors TEXT NOT NULL,
	name TEXT,
	description TEXT,
	autosaved INTEGER NOT NULL DEFAULT 0,
	createdAt TEXT NOT NULL,
	updatedAt TEXT NOT NULL
);
CREATE INDEX idx_workflow_history_workflow ON workflow_history (workflowId, createdAt);

CREATE TABLE shared_workflow (
	workflowId TEXT NOT NULL REFERENCES workflow_entity (id) ON DELETE CASCADE,
	projectId TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	role TEXT NOT NULL,
	createdAt TEXT NOT NULL,
	updatedAt TEXT NOT NULL,
	PRIMARY KEY (workflowId, projectId)
);
CREATE INDEX idx_shared_workflow_project ON shared_workflow (projectId);

CREATE TABLE tag_entity (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	createdAt TEXT NOT NULL,
	updatedAt TEXT NOT NULL
);

CREATE TABLE workflows_tags (
	workflowId TEXT NOT NULL REFERENCES workflow_entity (id) ON DELETE CASCADE,
	tagId TEXT NOT NULL REFERENCES tag_entity (id) ON DELETE CASCADE,
	PRIMARY KEY (workflowId, tagId)
);

CREATE TABLE credentials_entity (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT,
	data TEXT NOT NULL,
	type TEXT NOT NULL,
	isManaged INTEGER NOT NULL DEFAULT 0,
	isGlobal INTEGER NOT NULL DEFAULT 0,
	createdAt TEXT NOT NULL,
	updatedAt TEXT NOT NULL
);
CREATE INDEX idx_credentials_type ON credentials_entity (type);

CREATE TABLE shared_credentials (
	credentialsId TEXT NOT NULL REFERENCES credentials_entity (id) ON DELETE CASCADE,
	projectId TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	role TEXT NOT NULL,
	createdAt TEXT NOT NULL,
	updatedAt TEXT NOT NULL,
	PRIMARY KEY (credentialsId, projectId)
);
CREATE INDEX idx_shared_credentials_project ON shared_credentials (projectId);

CREATE TABLE execution_entity (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	workflowId TEXT NOT NULL,
	finished INTEGER NOT NULL DEFAULT 0,
	mode TEXT NOT NULL,
	status TEXT NOT NULL,
	retryOf TEXT,
	retrySuccessId TEXT,
	createdAt TEXT NOT NULL,
	startedAt TEXT,
	stoppedAt TEXT,
	deletedAt TEXT,
	waitTill TEXT,
	workflowVersionId TEXT,
	-- Cloudflare Workflows instance that runs this execution, if any.
	instanceId TEXT,
	jsonSizeBytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_execution_workflow ON execution_entity (workflowId, id);
CREATE INDEX idx_execution_status ON execution_entity (status, id);
CREATE INDEX idx_execution_wait ON execution_entity (waitTill, id);

CREATE TABLE execution_metadata (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	executionId INTEGER NOT NULL REFERENCES execution_entity (id) ON DELETE CASCADE,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	UNIQUE (executionId, key)
);

CREATE TABLE webhook_entity (
	workflowId TEXT NOT NULL REFERENCES workflow_entity (id) ON DELETE CASCADE,
	webhookPath TEXT NOT NULL,
	method TEXT NOT NULL,
	node TEXT NOT NULL,
	webhookId TEXT,
	pathLength INTEGER,
	PRIMARY KEY (webhookPath, method)
);
CREATE INDEX idx_webhook_dynamic ON webhook_entity (webhookId, method, pathLength);

-- Test webhooks registered by "Listen for test event", short lived.
CREATE TABLE test_webhook (
	webhookPath TEXT NOT NULL,
	method TEXT NOT NULL,
	workflowId TEXT NOT NULL,
	node TEXT NOT NULL,
	webhookId TEXT,
	pathLength INTEGER,
	pushRef TEXT,
	-- Full workflow JSON as sent by the editor, plus destination node etc.
	payload TEXT NOT NULL,
	expiresAt TEXT NOT NULL,
	PRIMARY KEY (webhookPath, method)
);

CREATE TABLE variables (
	id TEXT PRIMARY KEY,
	key TEXT NOT NULL UNIQUE,
	type TEXT NOT NULL DEFAULT 'string',
	value TEXT
);

CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	loadOnStartup INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE invalid_auth_token (
	token TEXT PRIMARY KEY,
	expiresAt TEXT NOT NULL
);
