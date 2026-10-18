import type { Scope } from '@n8n/permissions';

import { resourceScopes } from '../auth/scopes';
import { accessibleProjects, projectAccessClause } from './access';
import { nowIso } from './types';
import type { CredentialRow, ProjectRow, UserRow } from './types';

export interface CredentialSharing {
	credentialsId: string;
	projectId: string;
	role: string;
	project: ProjectRow;
}

export interface CredentialListOptions {
	includeGlobal: boolean;
	onlySharedWithMe: boolean;
	name?: string;
	type?: string;
	projectId?: string;
	skip: number;
	take?: number;
}

const COLUMNS = 'c.*';

export async function userProjectRoles(
	db: D1Database,
	userId: string,
): Promise<Map<string, string>> {
	const { results } = await db
		.prepare('SELECT projectId, role FROM project_relation WHERE userId = ?')
		.bind(userId)
		.all<{ projectId: string; role: string }>();
	return new Map(results.map((r) => [r.projectId, r.role]));
}

/** Credentials the user may read: all of them with a global read scope, else those shared with a project where project role and sharing role allow it. */
export async function listCredentials(
	db: D1Database,
	user: Pick<UserRow, 'id' | 'roleSlug'>,
	options: CredentialListOptions,
): Promise<CredentialRow[]> {
	const conditions: string[] = [];
	const bindings: Array<string | number> = [];

	const access = await accessibleProjects(db, user, 'credential:read', 'credential');
	if (options.onlySharedWithMe) {
		conditions.push(`EXISTS (SELECT 1 FROM shared_credentials s JOIN project_relation r ON r.projectId = s.projectId
			WHERE s.credentialsId = c.id AND r.userId = ? AND s.role = 'credential:user')`);
		bindings.push(user.id);
	} else if (!access.all) {
		const shared = projectAccessClause(access, 's.projectId', 's.role');
		const sharedSql = `EXISTS (SELECT 1 FROM shared_credentials s WHERE s.credentialsId = c.id AND ${shared.sql})`;
		conditions.push(options.includeGlobal ? `(${sharedSql} OR c.isGlobal = 1)` : sharedSql);
		bindings.push(...shared.bindings);
	}
	if (options.name) {
		conditions.push('c.name LIKE ?');
		bindings.push(`%${options.name}%`);
	}
	if (options.type) {
		conditions.push('c.type = ?');
		bindings.push(options.type);
	}
	if (options.projectId) {
		conditions.push(
			'EXISTS (SELECT 1 FROM shared_credentials s WHERE s.credentialsId = c.id AND s.projectId = ?)',
		);
		bindings.push(options.projectId);
	}

	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
	const limit = options.take === undefined ? '' : ' LIMIT ? OFFSET ?';
	const paging = options.take === undefined ? [] : [options.take, options.skip];
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM credentials_entity c ${where} ORDER BY c.updatedAt DESC, c.id${limit}`,
		)
		.bind(...bindings, ...paging)
		.all<CredentialRow>();
	return results;
}

export async function findCredential(db: D1Database, id: string): Promise<CredentialRow | null> {
	return await db
		.prepare('SELECT * FROM credentials_entity WHERE id = ?')
		.bind(id)
		.first<CredentialRow>();
}

export async function loadSharings(
	db: D1Database,
	credentialIds: string[],
): Promise<Map<string, CredentialSharing[]>> {
	const out = new Map<string, CredentialSharing[]>();
	if (credentialIds.length === 0) return out;
	const { results } = await db
		.prepare(
			`SELECT s.credentialsId, s.projectId, s.role, p.id AS pId, p.name AS pName, p.type AS pType, p.icon AS pIcon,
				p.description AS pDescription, p.creatorId AS pCreatorId, p.createdAt AS pCreatedAt, p.updatedAt AS pUpdatedAt
			FROM shared_credentials s JOIN project p ON p.id = s.projectId
			WHERE s.credentialsId IN (SELECT value FROM json_each(?))`,
		)
		.bind(JSON.stringify(credentialIds))
		.all<{
			credentialsId: string;
			projectId: string;
			role: string;
			pId: string;
			pName: string;
			pType: 'personal' | 'team';
			pIcon: string | null;
			pDescription: string | null;
			pCreatorId: string | null;
			pCreatedAt: string;
			pUpdatedAt: string;
		}>();
	for (const r of results) {
		const sharing: CredentialSharing = {
			credentialsId: r.credentialsId,
			projectId: r.projectId,
			role: r.role,
			project: {
				id: r.pId,
				name: r.pName,
				type: r.pType,
				icon: r.pIcon,
				description: r.pDescription,
				creatorId: r.pCreatorId,
				createdAt: r.pCreatedAt,
				updatedAt: r.pUpdatedAt,
			},
		};
		const list = out.get(r.credentialsId);
		if (list) list.push(sharing);
		else out.set(r.credentialsId, [sharing]);
	}
	return out;
}

/** Scopes of the user on a credential, see `resourceScopes`. A global credential is always readable. */
export function credentialScopes(
	user: Pick<UserRow, 'roleSlug'>,
	sharings: CredentialSharing[],
	relations: Map<string, string>,
	isGlobal = false,
): Scope[] {
	const scopes = new Set(resourceScopes(user, 'credential', sharings, relations));
	if (isGlobal) scopes.add('credential:read');
	return [...scopes];
}

/** The unique credential name stock n8n picks: "Name", then "Name 2", "Name 3" and so on. */
export async function uniqueCredentialName(db: D1Database, requested: string): Promise<string> {
	const { results } = await db
		.prepare("SELECT name FROM credentials_entity WHERE name LIKE ? ESCAPE '\\'")
		.bind(`${requested.replace(/[\\%_]/g, '\\$&')}%`)
		.all<{ name: string }>();
	if (results.length === 0) return requested;
	if (results.length === 1) return `${requested} 2`;
	const maxSuffix = results.reduce((max, { name }) => {
		const suffix = Number.parseInt(name.split(`${requested} `)[1] ?? '', 10);
		return Number.isNaN(suffix) ? max : Math.max(max, suffix);
	}, 2);
	return `${requested} ${maxSuffix + 1}`;
}

export async function insertCredential(
	db: D1Database,
	credential: Pick<CredentialRow, 'id' | 'name' | 'description' | 'data' | 'type' | 'isGlobal'>,
	projectId: string,
): Promise<CredentialRow> {
	const now = nowIso();
	await db.batch([
		db
			.prepare(
				'INSERT INTO credentials_entity (id, name, description, data, type, isManaged, isGlobal, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
			)
			.bind(
				credential.id,
				credential.name,
				credential.description,
				credential.data,
				credential.type,
				credential.isGlobal,
				now,
				now,
			),
		db
			.prepare(
				"INSERT INTO shared_credentials (credentialsId, projectId, role, createdAt, updatedAt) VALUES (?, ?, 'credential:owner', ?, ?)",
			)
			.bind(credential.id, projectId, now, now),
	]);
	const row = await findCredential(db, credential.id);
	if (!row) throw new Error('Credential was not stored');
	return row;
}

type CredentialPatch = Partial<
	Pick<CredentialRow, 'name' | 'description' | 'data' | 'type' | 'isGlobal'>
>;

const PATCHABLE: ReadonlyArray<keyof CredentialPatch> = [
	'name',
	'description',
	'data',
	'type',
	'isGlobal',
];

export async function updateCredential(
	db: D1Database,
	id: string,
	patch: CredentialPatch,
): Promise<void> {
	const keys = PATCHABLE.filter((k) => patch[k] !== undefined);
	const assignments = [...keys.map((k) => `${k} = ?`), 'updatedAt = ?'].join(', ');
	await db
		.prepare(`UPDATE credentials_entity SET ${assignments} WHERE id = ?`)
		.bind(...keys.map((k) => patch[k] ?? null), nowIso(), id)
		.run();
}

export async function deleteCredential(db: D1Database, id: string): Promise<void> {
	await db.prepare('DELETE FROM credentials_entity WHERE id = ?').bind(id).run();
}

/** Credentials shared with the project of a workflow, or with an explicit project, plus global ones. */
export async function listCredentialsUsableInProject(
	db: D1Database,
	scope: { workflowId: string } | { projectId: string },
): Promise<CredentialRow[]> {
	const [sql, binding] =
		'workflowId' in scope
			? [
					`SELECT DISTINCT c.* FROM credentials_entity c WHERE c.isGlobal = 1 OR EXISTS (
						SELECT 1 FROM shared_credentials sc JOIN shared_workflow sw ON sw.projectId = sc.projectId
						WHERE sc.credentialsId = c.id AND sw.workflowId = ?) ORDER BY c.updatedAt DESC`,
					scope.workflowId,
				]
			: [
					`SELECT DISTINCT c.* FROM credentials_entity c WHERE c.isGlobal = 1 OR EXISTS (
						SELECT 1 FROM shared_credentials sc WHERE sc.credentialsId = c.id AND sc.projectId = ?) ORDER BY c.updatedAt DESC`,
					scope.projectId,
				];
	const { results } = await db.prepare(sql).bind(binding).all<CredentialRow>();
	return results;
}
