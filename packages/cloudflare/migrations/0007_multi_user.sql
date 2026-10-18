-- Invited users get a personal project when they are created. One personal project for each user.
CREATE UNIQUE INDEX idx_project_personal_creator ON project (creatorId) WHERE type = 'personal';
