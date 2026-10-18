CREATE TABLE annotation_tag_entity (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	createdAt TEXT NOT NULL,
	updatedAt TEXT NOT NULL
);

CREATE TABLE execution_annotations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	vote TEXT,
	note TEXT,
	executionId INTEGER NOT NULL UNIQUE REFERENCES execution_entity (id) ON DELETE CASCADE
);

CREATE TABLE execution_annotation_tags (
	annotationId INTEGER NOT NULL REFERENCES execution_annotations (id) ON DELETE CASCADE,
	tagId TEXT NOT NULL REFERENCES annotation_tag_entity (id) ON DELETE CASCADE,
	PRIMARY KEY (annotationId, tagId)
);
CREATE INDEX idx_annotation_tags_tag ON execution_annotation_tags (tagId);
