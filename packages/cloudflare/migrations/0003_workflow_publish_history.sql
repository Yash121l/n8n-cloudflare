-- Activation and deactivation events of a workflow, shown in the version history panel.
CREATE TABLE workflow_publish_history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	workflowId TEXT NOT NULL REFERENCES workflow_entity (id) ON DELETE CASCADE,
	versionId TEXT,
	event TEXT NOT NULL,
	userId TEXT,
	createdAt TEXT NOT NULL
);
CREATE INDEX idx_workflow_publish_history_workflow ON workflow_publish_history (workflowId, id);
