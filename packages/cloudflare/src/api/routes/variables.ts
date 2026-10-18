import {
	CreateVariableRequestDto,
	UpdateVariableRequestDto,
	VariableListRequestDto,
} from '@n8n/api-types';
import { hasScope } from '@n8n/permissions';
import type { Scope } from '@n8n/permissions';
import { Hono } from 'hono';

import { globalScopesOf, projectScopesOf } from '../../auth/scopes';
import { requireUser } from '../../auth/middleware';
import { accessibleProjects } from '../../db/access';
import { newId } from '../../db/ids';
import { userProjectRole } from '../../db/projects';
import {
	deleteVariable,
	findVariable,
	insertVariable,
	listVariables,
	updateVariable,
	variableKeyTaken,
} from '../../db/variables';
import type { VariableRow } from '../../db/variables';
import type { UserRow } from '../../db/types';
import { ok } from '../app';
import type { AppContext, AppEnv } from '../app';
import { badRequest, forbidden, notFound } from '../errors';
import { parseDto, queryParams, readJson } from '../http';

export const variableRoutes = new Hono<AppEnv>();

type VariableAction = 'create' | 'read' | 'update' | 'delete' | 'list';

const globalScope = (action: VariableAction): Scope => `variable:${action}`;
const projectScope = (action: VariableAction): Scope => `projectVariable:${action}`;

async function canAct(
	c: AppContext,
	user: UserRow,
	action: VariableAction,
	projectId: string | null,
): Promise<boolean> {
	if (!projectId) return hasScope(globalScope(action), { global: globalScopesOf(user.roleSlug) });
	const role = await userProjectRole(c.env.DB, user.id, projectId);
	return hasScope(projectScope(action), {
		global: globalScopesOf(user.roleSlug),
		project: projectScopesOf(role),
	});
}

const toJson = (row: VariableRow) => ({
	id: row.id,
	key: row.key,
	type: row.type,
	value: row.value ?? '',
	project: row.projectId ? { id: row.projectId, name: row.projectName ?? '' } : null,
});

variableRoutes.get('/variables', async (c) => {
	const user = requireUser(c);
	const query = parseDto(VariableListRequestDto, queryParams(c));
	const canListGlobal = hasScope('variable:list', { global: globalScopesOf(user.roleSlug) });
	const projects = await accessibleProjects(c.env.DB, user, 'projectVariable:list');
	const visibleProjectIds = projects.all ? null : new Set(projects.projectIds);

	const rows = (await listVariables(c.env.DB)).filter((row) => {
		const hasAccess = row.projectId
			? visibleProjectIds === null || visibleProjectIds.has(row.projectId)
			: canListGlobal;
		const matchesState = query.state !== 'empty' || (row.value ?? '') === '';
		const matchesProject =
			query.projectId === undefined || (row.projectId ?? 'null') === query.projectId;
		return hasAccess && matchesState && matchesProject;
	});
	return ok(c, rows.map(toJson));
});

variableRoutes.post('/variables', async (c) => {
	const user = requireUser(c);
	const payload = parseDto(CreateVariableRequestDto, await readJson(c));
	const projectId = payload.projectId ?? null;
	if (!(await canAct(c, user, 'create', projectId))) {
		throw forbidden(
			`You are not allowed to create a variable${projectId ? ' in this project' : ''}`,
		);
	}
	if (await variableKeyTaken(c.env.DB, payload.key, projectId)) {
		throw badRequest(
			projectId
				? `A variable with key "${payload.key}" already exists in the specified project`
				: `A global variable with key "${payload.key}" already exists`,
		);
	}
	const id = newId();
	await insertVariable(c.env.DB, {
		id,
		key: payload.key,
		type: payload.type,
		value: payload.value,
		projectId,
	});
	const created = await findVariable(c.env.DB, id);
	if (!created) throw new Error('Variable was not stored');
	return ok(c, toJson(created));
});

variableRoutes.get('/variables/:id', async (c) => {
	const user = requireUser(c);
	const row = await findVariable(c.env.DB, c.req.param('id'));
	if (!row) throw notFound(`Variable with id ${c.req.param('id')} not found`);
	if (!(await canAct(c, user, 'read', row.projectId))) {
		throw forbidden('You are not allowed to access this variable');
	}
	return ok(c, toJson(row));
});

variableRoutes.patch('/variables/:id', async (c) => {
	const user = requireUser(c);
	const id = c.req.param('id');
	const payload = parseDto(UpdateVariableRequestDto, await readJson(c));
	const existing = await findVariable(c.env.DB, id);
	if (!existing) throw notFound(`Variable with id ${id} not found`);
	if (!(await canAct(c, user, 'update', existing.projectId))) {
		throw forbidden('You are not allowed to update this variable');
	}

	const projectId = payload.projectId === undefined ? existing.projectId : payload.projectId;
	if (projectId !== existing.projectId && !(await canAct(c, user, 'update', projectId))) {
		throw forbidden(
			`You are not allowed to move this variable to ${projectId ? 'the specified project' : 'the global scope'}`,
		);
	}
	const key = payload.key ?? existing.key;
	if (await variableKeyTaken(c.env.DB, key, projectId, id)) {
		throw badRequest(
			projectId
				? `A variable with key "${key}" already exists in the specified project`
				: `A global variable with key "${key}" already exists`,
		);
	}
	await updateVariable(c.env.DB, id, {
		key,
		type: payload.type ?? existing.type,
		value: payload.value ?? existing.value ?? '',
		projectId,
	});
	const updated = await findVariable(c.env.DB, id);
	if (!updated) throw new Error('Variable disappeared during update');
	return ok(c, toJson(updated));
});

variableRoutes.delete('/variables/:id', async (c) => {
	const user = requireUser(c);
	const id = c.req.param('id');
	const existing = await findVariable(c.env.DB, id);
	if (existing && !(await canAct(c, user, 'delete', existing.projectId))) {
		throw forbidden('You are not allowed to delete this variable');
	}
	if (!existing && !hasScope('variable:delete', { global: globalScopesOf(user.roleSlug) })) {
		throw forbidden('You are not allowed to delete this variable');
	}
	await deleteVariable(c.env.DB, id);
	return ok(c, true);
});
