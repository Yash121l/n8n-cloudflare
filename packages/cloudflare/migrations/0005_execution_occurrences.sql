ALTER TABLE execution_entity ADD COLUMN occurrenceKey TEXT;
CREATE UNIQUE INDEX idx_execution_occurrence ON execution_entity (occurrenceKey);
