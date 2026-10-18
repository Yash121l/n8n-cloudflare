import type { Scope } from '@n8n/permissions';

import { globalScopesOf, projectScopesOf, sharingRolesWithScope } from '../auth/scopes';
import type { UserRow } from './types';

/**
 * `sharingRoles` is set when the access is for a workflow or credential. A shared row then counts only
 * when its sharing role grants the scope too, like the `role` and `project` filters of stock n8n.
 */
export type ProjectAccess =
	| { all: true }
	| { all: false; projectIds: string[]; sharingRoles?: string[] };

/**
 * Projects in which the user holds `scope`. A global scope (owner, admin) covers every project;
 * otherwise only the projects where the project role of the user grants it.
 */
export async function accessibleProjects(
	db: D1Database,
	user: Pick<UserRow, 'id' | 'roleSlug'>,
	scope: Scope,
	resource?: 'workflow' | 'credential',
): Promise<ProjectAccess> {
	if (globalScopesOf(user.roleSlug).includes(scope)) return { all: true };
	const { results } = await db
		.prepare('SELECT projectId, role FROM project_relation WHERE userId = ?')
		.bind(user.id)
		.all<{ projectId: string; role: string }>();
	return {
		all: false,
		projectIds: results
			.filter((r) => projectScopesOf(r.role).includes(scope))
			.map((r) => r.projectId),
		...(resource ? { sharingRoles: sharingRolesWithScope(resource, scope) } : {}),
	};
}

/**
 * SQL condition for `column IN accessible projects`, plus its binding. Uses `json_each` so the
 * number of bound variables stays at one per list, because D1 limits a statement to 100.
 * Pass `roleColumn` to apply the sharing roles as well.
 */
export function projectAccessClause(
	access: ProjectAccess,
	column: string,
	roleColumn?: string,
): { sql: string; bindings: string[] } {
	if (access.all) return { sql: '1 = 1', bindings: [] };
	const projects = `${column} IN (SELECT value FROM json_each(?))`;
	if (roleColumn && access.sharingRoles) {
		return {
			sql: `${projects} AND ${roleColumn} IN (SELECT value FROM json_each(?))`,
			bindings: [JSON.stringify(access.projectIds), JSON.stringify(access.sharingRoles)],
		};
	}
	return { sql: projects, bindings: [JSON.stringify(access.projectIds)] };
}
