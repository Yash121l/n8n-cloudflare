import { newId } from './ids';
import { nowIso } from './types';
import type { ProjectRow, UserRow } from './types';

export interface ProjectRelationRow {
	projectId: string;
	userId: string;
	role: string;
}

export const PERSONAL_OWNER_ROLE = 'project:personalOwner';
/** Chat users hold their personal project as viewers, like in stock n8n. */
export const PROJECT_VIEWER_ROLE = 'project:viewer';

export const personalProjectName = (user: Pick<UserRow, 'firstName' | 'lastName' | 'email'>) =>
	`${user.firstName ?? ''} ${user.lastName ?? ''} <${user.email ?? ''}>`.trim();

/** The project row and the statements that insert it with its owner relation, so callers can batch them with other writes. */
export function personalProjectStatements(
	db: D1Database,
	user: Pick<UserRow, 'id' | 'firstName' | 'lastName' | 'email'>,
	role = PERSONAL_OWNER_ROLE,
): { project: ProjectRow; statements: D1PreparedStatement[] } {
	const now = nowIso();
	const project: ProjectRow = {
		id: newId(),
		name: personalProjectName(user),
		type: 'personal',
		icon: null,
		description: null,
		creatorId: user.id,
		createdAt: now,
		updatedAt: now,
	};
	const statements = [
		db
			.prepare(
				'INSERT INTO project (id, name, type, icon, description, creatorId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
			)
			.bind(
				project.id,
				project.name,
				project.type,
				project.icon,
				project.description,
				project.creatorId,
				now,
				now,
			),
		db
			.prepare(
				'INSERT INTO project_relation (projectId, userId, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
			)
			.bind(project.id, user.id, role, now, now),
	];
	return { project, statements };
}

export async function findPersonalProject(
	db: D1Database,
	userId: string,
): Promise<ProjectRow | null> {
	return await db
		.prepare(
			`SELECT p.* FROM project p
			JOIN project_relation r ON r.projectId = p.id
			WHERE r.userId = ? AND p.type = 'personal' AND p.creatorId = r.userId AND r.role IN (?, ?)`,
		)
		.bind(userId, PERSONAL_OWNER_ROLE, PROJECT_VIEWER_ROLE)
		.first<ProjectRow>();
}

export async function findProjectById(db: D1Database, id: string): Promise<ProjectRow | null> {
	return await db.prepare('SELECT * FROM project WHERE id = ?').bind(id).first<ProjectRow>();
}

export async function listProjectRelations(
	db: D1Database,
	projectId: string,
): Promise<ProjectRelationRow[]> {
	const { results } = await db
		.prepare('SELECT projectId, userId, role FROM project_relation WHERE projectId = ?')
		.bind(projectId)
		.all<ProjectRelationRow>();
	return results;
}

export async function userProjectRole(
	db: D1Database,
	userId: string,
	projectId: string,
): Promise<string | null> {
	const row = await db
		.prepare('SELECT role FROM project_relation WHERE userId = ? AND projectId = ?')
		.bind(userId, projectId)
		.first<{ role: string }>();
	return row?.role ?? null;
}

/** Projects the user belongs to, with the role the user has in each. */
export async function listUserProjects(
	db: D1Database,
	userId: string,
): Promise<Array<ProjectRow & { relationRole: string }>> {
	const { results } = await db
		.prepare(
			`SELECT p.*, r.role AS relationRole FROM project p
			JOIN project_relation r ON r.projectId = p.id
			WHERE r.userId = ?
			ORDER BY CASE p.type WHEN 'personal' THEN 0 ELSE 1 END, p.name`,
		)
		.bind(userId)
		.all<ProjectRow & { relationRole: string }>();
	return results;
}

export async function listAllProjects(db: D1Database): Promise<ProjectRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM project ORDER BY CASE type WHEN 'personal' THEN 0 ELSE 1 END, name")
		.all<ProjectRow>();
	return results;
}
