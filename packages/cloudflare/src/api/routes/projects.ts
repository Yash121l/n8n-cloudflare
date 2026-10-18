import { hasScope } from '@n8n/permissions';
import { Hono } from 'hono';

import { allRoles, globalScopesOf, scopesForProject } from '../../auth/scopes';
import { requireUser } from '../../auth/middleware';
import {
	findProjectById,
	listAllProjects,
	listProjectRelations,
	listUserProjects,
	userProjectRole,
} from '../../db/projects';
import type { UserRow } from '../../db/types';
import { listUsers } from '../../db/users';
import type { AppContext, AppEnv } from '../app';
import { ok } from '../app';
import { forbidden, notFound } from '../errors';
import { asBool, queryParams, toInt } from '../http';
import { toProjectJson } from '../serializers';

export const projectRoutes = new Hono<AppEnv>();

const TEAM_PROJECTS_NOT_LICENSED = 'Plan lacks license for this feature';

/** Projects the user may see, each with the user's role and scopes, as `ProjectListItem`. */
async function projectListItems(c: AppContext, user: UserRow, onlyMembership: boolean) {
	const memberships = await listUserProjects(c.env.DB, user.id);
	const items = memberships.map(({ relationRole, ...project }) => ({
		...toProjectJson(project),
		role: relationRole,
		scopes: scopesForProject(user, relationRole),
	}));
	if (onlyMembership || !hasScope('project:read', { global: globalScopesOf(user.roleSlug) })) {
		return items;
	}
	const known = new Set(items.map((item) => item.id));
	const others = (await listAllProjects(c.env.DB)).filter(
		(project) => project.type === 'team' && !known.has(project.id),
	);
	for (const project of others) {
		items.push({
			...toProjectJson(project),
			role: user.roleSlug,
			scopes: scopesForProject(user, null),
		});
	}
	return items;
}

projectRoutes.get('/projects/my-projects', async (c) => {
	const user = requireUser(c);
	return ok(c, await projectListItems(c, user, false));
});

projectRoutes.get('/projects/personal', async (c) => {
	const user = requireUser(c);
	const memberships = await listUserProjects(c.env.DB, user.id);
	const personal = memberships.find((project) => project.type === 'personal');
	if (!personal) throw notFound('Could not find a personal project for this user');
	const { relationRole, ...project } = personal;
	return ok(c, {
		...toProjectJson(project),
		scopes: scopesForProject(user, relationRole),
		rolesManaged: false,
	});
});

projectRoutes.get('/projects/count', async (c) => {
	requireUser(c);
	const rows = await c.env.DB.prepare('SELECT type, COUNT(*) AS n FROM project GROUP BY type').all<{
		type: string;
		n: number;
	}>();
	const counts = { personal: 0, team: 0, public: 0 };
	for (const row of rows.results) {
		if (row.type === 'personal') counts.personal = row.n;
		else if (row.type === 'team') counts.team = row.n;
	}
	return ok(c, counts);
});

async function paginatedProjects(c: AppContext) {
	const user = requireUser(c);
	const params = queryParams(c);
	let items = await projectListItems(c, user, false);

	const search = typeof params.search === 'string' ? params.search.trim().toLowerCase() : '';
	if (search) items = items.filter((item) => item.name.toLowerCase().includes(search));
	if (params.type === 'personal' || params.type === 'team') {
		items = items.filter((item) => item.type === params.type);
	}

	const paginated = params.take !== undefined || params.skip !== undefined;
	if (!paginated) return c.json(items);
	const skip = toInt(params.skip, 0);
	const take = toInt(params.take, items.length);
	return c.json({ count: items.length, data: items.slice(skip, skip + take) });
}

projectRoutes.get('/projects', paginatedProjects);
projectRoutes.get('/projects/sharing-candidates', async (c) => {
	const user = requireUser(c);
	const items = await projectListItems(c, user, false);
	return c.json({ count: items.length, data: items });
});

projectRoutes.get('/projects/:projectId', async (c) => {
	const user = requireUser(c);
	const project = await findProjectById(c.env.DB, c.req.param('projectId'));
	if (!project) throw notFound('Project not found');
	const role = await userProjectRole(c.env.DB, user.id, project.id);
	const scopes = scopesForProject(user, role);
	if (!hasScope('project:read', { global: scopes })) throw forbidden();

	const relations = await listProjectRelations(c.env.DB, project.id);
	const users = new Map((await listUsers(c.env.DB)).map((row) => [row.id, row]));
	return ok(c, {
		...toProjectJson(project),
		creatorId: project.creatorId,
		relations: relations.flatMap((relation) => {
			const member = users.get(relation.userId);
			return member
				? [
						{
							id: member.id,
							email: member.email,
							firstName: member.firstName,
							lastName: member.lastName,
							role: relation.role,
						},
					]
				: [];
		}),
		implicitMembers: [],
		scopes,
		rolesManaged: false,
	});
});

projectRoutes.post('/projects', () => {
	throw forbidden(TEAM_PROJECTS_NOT_LICENSED);
});
projectRoutes.patch('/projects/:projectId', () => {
	throw forbidden(TEAM_PROJECTS_NOT_LICENSED);
});
projectRoutes.delete('/projects/:projectId', () => {
	throw forbidden(TEAM_PROJECTS_NOT_LICENSED);
});
projectRoutes.post('/projects/:projectId/users', () => {
	throw forbidden(TEAM_PROJECTS_NOT_LICENSED);
});

projectRoutes.get('/roles', async (c) => {
	requireUser(c);
	const roles = allRoles();
	if (asBool(c.req.query('withUsageCount'))) {
		const byUser = await countBy(
			c.env.DB,
			'SELECT roleSlug AS slug, COUNT(*) AS n FROM user GROUP BY roleSlug',
		);
		const byProject = await countBy(
			c.env.DB,
			'SELECT role AS slug, COUNT(*) AS n FROM project_relation GROUP BY role',
		);
		roles.global = roles.global.map((role) => ({
			...role,
			usedByUsers: byUser.get(role.slug) ?? 0,
		}));
		roles.project = roles.project.map((role) => ({
			...role,
			usedByProjects: byProject.get(role.slug) ?? 0,
		}));
	}
	return ok(c, roles);
});

async function countBy(db: D1Database, sql: string): Promise<Map<string, number>> {
	const { results } = await db.prepare(sql).all<{ slug: string; n: number }>();
	return new Map(results.map((row) => [row.slug, row.n]));
}
