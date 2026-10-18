import {
	AcceptInvitationRequestDto,
	InviteUsersRequestDto,
	RoleChangeRequestDto,
	SettingsUpdateRequestDto,
	UsersListFilterDto,
	userBaseSchema,
	userDetailSchema,
} from '@n8n/api-types';
import { ALL_ROLES, hasScope } from '@n8n/permissions';
import type { Scope } from '@n8n/permissions';
import { Hono } from 'hono';

import { issueAuthCookie, requireUser } from '../../auth/middleware';
import { hashPassword } from '../../auth/password';
import { assertScope, globalScopesOf, scopesForProject } from '../../auth/scopes';
import { inviteUrl, passwordResetUrl, verifyInviteToken } from '../../auth/tokens';
import { deleteCredential } from '../../db/credentials';
import { workflowExecutionIds } from '../../db/executions';
import { newUuid } from '../../db/ids';
import {
	PERSONAL_OWNER_ROLE,
	PROJECT_VIEWER_ROLE,
	findPersonalProject,
	findProjectById,
	personalProjectName,
	personalProjectStatements,
	userProjectRole,
} from '../../db/projects';
import { nowIso, parseJson } from '../../db/types';
import type { UserRow } from '../../db/types';
import {
	ADMIN_ROLE,
	CHAT_USER_ROLE,
	OWNER_ROLE,
	findUserById,
	findUsersByEmails,
	hasClaimedOwner,
	updateUser,
} from '../../db/users';
import { deleteWorkflow, findWorkflowDoc } from '../../db/workflows';
import * as runtime from '../../runtime/service';
import type { AppContext, AppEnv } from '../app';
import { baseUrlOf, ok, runContextOf } from '../app';
import { HttpError, badRequest, forbidden, notFound } from '../errors';
import { parseDto, queryParams, readJson, readJsonValue } from '../http';
import { limitTokenByIp } from '../rate-limit';
import { toPublicUser } from '../serializers';
import { deactivate } from '../workflow-actions';

/** Users, invitations and roles, like the users and invitation controllers of stock n8n. */
export const userRoutes = new Hono<AppEnv>();

/** Built-in global roles other than owner. Custom roles need a license in stock n8n. */
const ASSIGNABLE_ROLES = new Set(
	ALL_ROLES.global.map((role) => role.slug).filter((slug) => slug !== OWNER_ROLE),
);

const requireGlobalScope = (user: UserRow, scope: Scope) =>
	assertScope(globalScopesOf(user.roleSlug), scope);

function assertAssignable(role: string): void {
	if (!ASSIGNABLE_ROLES.has(role))
		throw badRequest(`Role ${role} does not exist or cannot be assigned`);
}

/** Reads the inviter and invitee of an invite token, like `UserService.getInvitationIdsFromPayload`. */
export async function invitationIds(
	c: AppContext,
	token: string,
): Promise<{ inviterId: string; inviteeId: string }> {
	if (!(await hasClaimedOwner(c.env.DB))) throw badRequest('Instance owner not found');
	const ids = await verifyInviteToken(c.env, token);
	if (!ids) throw badRequest('Invalid invite URL');
	return ids;
}

const asArray = (value: string | string[] | undefined) =>
	value === undefined ? undefined : Array.isArray(value) ? value : [value];

const ROLE_ORDER_SQL =
	"CASE u.roleSlug WHEN 'global:owner' THEN 0 WHEN 'global:admin' THEN 1 ELSE 2 END";

interface RelationRow {
	userId: string;
	role: string;
	id: string;
	name: string;
	icon: string | null;
}

userRoutes.get('/users', async (c) => {
	const current = requireUser(c);
	requireGlobalScope(current, 'user:list');
	const db = c.env.DB;
	const params = queryParams(c);
	const { filter, select, take, skip, expand, sortBy } = parseDto(UsersListFilterDto, {
		...params,
		select: asArray(params.select),
		expand: asArray(params.expand),
		sortBy: asArray(params.sortBy),
	});

	if (filter?.projectId) {
		const project = await findProjectById(db, filter.projectId);
		const role = project ? await userProjectRole(db, current.id, project.id) : null;
		if (!project || !hasScope('project:list', { global: scopesForProject(current, role) })) {
			throw notFound('Project not found');
		}
	}

	const where: string[] = [];
	const bindings: Array<string | number> = [];
	const add = (sql: string, ...values: Array<string | number>) => {
		where.push(sql);
		bindings.push(...values);
	};
	if (filter?.email !== undefined) add('u.email = ?', filter.email);
	if (filter?.firstName !== undefined) add('u.firstName = ?', filter.firstName);
	if (filter?.lastName !== undefined) add('u.lastName = ?', filter.lastName);
	if (filter?.mfaEnabled !== undefined) add('u.mfaEnabled = ?', filter.mfaEnabled ? 1 : 0);
	if (filter?.isOwner !== undefined)
		add(filter.isOwner ? 'u.roleSlug = ?' : 'u.roleSlug <> ?', OWNER_ROLE);
	if (filter?.ids !== undefined && filter.ids.length > 0) {
		add('u.id IN (SELECT value FROM json_each(?))', JSON.stringify(filter.ids));
	}
	if (filter?.isPending !== undefined) {
		if (filter.isPending) add('u.password IS NULL AND u.roleSlug <> ?', OWNER_ROLE);
		else add('u.password IS NOT NULL');
	}
	if (filter?.fullText !== undefined) {
		const text = `%${filter.fullText}%`;
		add(
			'(LOWER(u.firstName) LIKE LOWER(?) OR LOWER(u.lastName) LIKE LOWER(?) OR LOWER(u.email) LIKE LOWER(?))',
			text,
			text,
			text,
		);
	}
	if (filter?.projectId !== undefined) {
		add('u.id IN (SELECT userId FROM project_relation WHERE projectId = ?)', filter.projectId);
	}
	const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
	const order = (sortBy ?? ['role:asc', 'firstName:asc']).map((sort) => {
		const [field, direction] = sort.split(':');
		return `${field === 'role' ? ROLE_ORDER_SQL : `u.${field}`} ${direction === 'desc' ? 'DESC' : 'ASC'}`;
	});

	const [countRow, rows] = await Promise.all([
		db
			.prepare(`SELECT COUNT(*) AS n FROM user u ${whereSql}`)
			.bind(...bindings)
			.first<{ n: number }>(),
		db
			.prepare(
				`SELECT u.* FROM user u ${whereSql} ORDER BY ${[...order, 'u.createdAt ASC'].join(', ')} LIMIT ? OFFSET ?`,
			)
			.bind(...bindings, take >= 0 ? take : -1, skip ?? 0)
			.all<UserRow>(),
	]);

	let relations: Map<string, Array<Record<string, unknown>>> | null = null;
	if (expand?.includes('projectRelations')) {
		const { results } = await db
			.prepare(
				`SELECT r.userId, r.role, p.id, p.name, p.icon FROM project_relation r
				JOIN project p ON p.id = r.projectId
				WHERE r.role <> ? AND r.userId IN (SELECT value FROM json_each(?))`,
			)
			.bind(PERSONAL_OWNER_ROLE, JSON.stringify(rows.results.map((row) => row.id)))
			.all<RelationRow>();
		relations = new Map();
		for (const { userId, icon, ...relation } of results) {
			const list = relations.get(userId) ?? [];
			list.push({ ...relation, icon: parseJson<unknown>(icon, null) });
			relations.set(userId, list);
		}
	}

	const seesAllDetails = hasScope('user:create', { global: globalScopesOf(current.roleSlug) });
	const items = rows.results.map((row) => {
		const full: Record<string, unknown> = { ...toPublicUser(row) };
		if (relations) full.projectRelations = relations.get(row.id) ?? [];
		let user = full;
		if (select) {
			user = { id: row.id, ...(relations ? { projectRelations: full.projectRelations } : {}) };
			for (const key of select) user[key] = full[key];
		}
		const parsed: Record<string, unknown> =
			seesAllDetails || row.id === current.id
				? userDetailSchema.parse(user)
				: userBaseSchema.parse(user);
		if (select && !select.includes('id')) delete parsed.id;
		return parsed;
	});
	return ok(c, { count: countRow?.n ?? 0, items });
});

userRoutes.post('/invitations', async (c) => {
	const inviter = requireUser(c);
	requireGlobalScope(inviter, 'user:create');
	const invitations = parseDto(InviteUsersRequestDto, await readJsonValue(c));
	if (invitations.length === 0) return ok(c, []);
	if (!(await hasClaimedOwner(c.env.DB)))
		throw badRequest('You must set up your own account before inviting others');
	for (const { role } of invitations) assertAssignable(role);

	const db = c.env.DB;
	const requested = new Map<string, string>();
	for (const { email, role } of invitations) {
		if (!requested.has(email.toLowerCase())) requested.set(email.toLowerCase(), role);
	}
	const existing = await findUsersByEmails(db, [...requested.keys()]);
	const existingEmails = new Set(existing.map((user) => user.email));

	const invited = new Map<string, string>();
	const statements: D1PreparedStatement[] = [];
	const now = nowIso();
	for (const [email, role] of requested) {
		if (existingEmails.has(email)) continue;
		const id = newUuid();
		invited.set(email, id);
		statements.push(
			db
				.prepare(
					'INSERT INTO user (id, email, roleSlug, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
				)
				.bind(id, email, role, now, now),
			...personalProjectStatements(
				db,
				{ id, email, firstName: null, lastName: null },
				role === CHAT_USER_ROLE ? PROJECT_VIEWER_ROLE : PERSONAL_OWNER_ROLE,
			).statements,
		);
	}
	if (statements.length > 0) {
		try {
			await db.batch(statements);
		} catch (error) {
			throw new HttpError(
				500,
				'An error occurred during user creation',
				error instanceof Error ? error.message : undefined,
			);
		}
	}
	for (const user of existing) {
		if (user.password === null && user.email) invited.set(user.email, user.id);
	}

	// Email is not set up, so the response carries the invite link for the owner to copy, as stock does.
	const baseUrl = baseUrlOf(c);
	const result = await Promise.all(
		[...invited].map(async ([email, id]) => ({
			user: {
				id,
				email,
				emailSent: false,
				role: invitations[0].role,
				inviteAcceptUrl: await inviteUrl(c.env, baseUrl, inviter.id, id),
			},
			error: '',
		})),
	);
	return ok(c, result);
});

userRoutes.post('/invitations/accept', async (c) => {
	await limitTokenByIp(c);
	const { token, firstName, lastName, password } = parseDto(
		AcceptInvitationRequestDto,
		await readJson(c),
	);
	const { inviterId, inviteeId } = await invitationIds(c, token);
	const db = c.env.DB;
	const [inviter, invitee] = await Promise.all([
		findUserById(db, inviterId),
		findUserById(db, inviteeId),
	]);
	if (!inviter || !invitee) throw badRequest('Invalid payload or URL');
	if (invitee.password) throw badRequest('This invite has been accepted already');

	const now = nowIso();
	const project = await findPersonalProject(db, invitee.id);
	const [result] = await db.batch([
		db
			.prepare(
				'UPDATE user SET firstName = ?, lastName = ?, password = ?, updatedAt = ? WHERE id = ? AND password IS NULL',
			)
			.bind(firstName, lastName, await hashPassword(password), now, invitee.id),
		...(project
			? [
					db
						.prepare('UPDATE project SET name = ?, updatedAt = ? WHERE id = ?')
						.bind(
							personalProjectName({ firstName, lastName, email: invitee.email }),
							now,
							project.id,
						),
				]
			: []),
	]);
	if (result.meta.changes === 0) throw badRequest('This invite has been accepted already');

	const updated = await findUserById(db, invitee.id);
	if (!updated) throw new HttpError(500, 'User could not be updated');
	await issueAuthCookie(c, updated, false);
	return ok(c, toPublicUser(updated, { withScopes: true }));
});

userRoutes.post('/users/:id/invite-link', async (c) => {
	const user = requireUser(c);
	requireGlobalScope(user, 'user:generateInviteLink');
	const target = await findUserById(c.env.DB, c.req.param('id'));
	if (!target) throw notFound('User to generate invite link for not found');
	return ok(c, { link: await inviteUrl(c.env, baseUrlOf(c), user.id, target.id) });
});

userRoutes.get('/users/:id/password-reset-link', async (c) => {
	const user = requireUser(c);
	requireGlobalScope(user, 'user:resetPassword');
	const target = await findUserById(c.env.DB, c.req.param('id'));
	if (!target) throw notFound('User not found');
	if (user.roleSlug === ADMIN_ROLE && target.roleSlug === OWNER_ROLE) {
		throw forbidden('Admin cannot reset password of global owner');
	}
	return ok(c, { link: await passwordResetUrl(c.env, baseUrlOf(c), target) });
});

userRoutes.patch('/users/:id/settings', async (c) => {
	const user = requireUser(c);
	requireGlobalScope(user, 'user:update');
	const payload = parseDto(SettingsUpdateRequestDto, await readJson(c));
	const target = await findUserById(c.env.DB, c.req.param('id'));
	if (!target) throw notFound('User not found');
	const settings = { ...parseJson<Record<string, unknown>>(target.settings, {}), ...payload };
	await updateUser(c.env.DB, target.id, { settings: JSON.stringify(settings) });
	return ok(c, settings);
});

/** Moves what one project owns and is shared to another, like `OwnershipTransferService.transferAllResources`. */
function transferStatements(db: D1Database, from: string, to: string): D1PreparedStatement[] {
	const now = nowIso();
	const resources = [
		['shared_workflow', 'workflowId', 'workflow:owner'],
		['shared_credentials', 'credentialsId', 'credential:owner'],
	] as const;
	const statements = resources.flatMap(([table, column, ownerRole]) => [
		// Ownership overrides any sharing the destination already has.
		db
			.prepare(
				`DELETE FROM ${table} WHERE projectId = ? AND ${column} IN (SELECT ${column} FROM ${table} WHERE projectId = ? AND role = ?)`,
			)
			.bind(to, from, ownerRole),
		db
			.prepare(`UPDATE ${table} SET projectId = ?, updatedAt = ? WHERE projectId = ? AND role = ?`)
			.bind(to, now, from, ownerRole),
		// Other sharings move only where the destination has none yet.
		db
			.prepare(
				`INSERT OR IGNORE INTO ${table} (${column}, projectId, role, createdAt, updatedAt) SELECT ${column}, ?, role, ?, ? FROM ${table} WHERE projectId = ?`,
			)
			.bind(to, now, now, from),
	]);
	statements.push(
		db
			.prepare('UPDATE folder SET projectId = ?, updatedAt = ? WHERE projectId = ?')
			.bind(to, now, from),
	);
	return statements;
}

/** Deletes the workflows and credentials a project owns, stopping active workflows first. */
async function deleteOwnedResources(
	c: AppContext,
	actor: UserRow,
	projectId: string,
): Promise<void> {
	const db = c.env.DB;
	const [workflows, credentials] = await Promise.all([
		db
			.prepare(
				"SELECT workflowId AS id FROM shared_workflow WHERE projectId = ? AND role = 'workflow:owner'",
			)
			.bind(projectId)
			.all<{ id: string }>(),
		db
			.prepare(
				"SELECT credentialsId AS id FROM shared_credentials WHERE projectId = ? AND role = 'credential:owner'",
			)
			.bind(projectId)
			.all<{ id: string }>(),
	]);
	const rc = runContextOf(c);
	for (const { id } of workflows.results) {
		const doc = await findWorkflowDoc(db, id);
		if (!doc) continue;
		await deactivate(rc, actor, doc);
		const executionIds = await workflowExecutionIds(db, id);
		await runtime.deleteExecutionData(c.env, executionIds.map(String));
		await deleteWorkflow(db, id);
	}
	for (const { id } of credentials.results) await deleteCredential(db, id);
}

userRoutes.delete('/users/:id', async (c) => {
	const actor = requireUser(c);
	requireGlobalScope(actor, 'user:delete');
	const db = c.env.DB;
	const id = c.req.param('id');
	const transferId = c.req.query('transferId') || undefined;
	if (actor.id === id) throw badRequest('Cannot delete your own user');

	const target = await findUserById(db, id);
	if (!target)
		throw notFound(
			'Request to delete a user failed because the user to delete was not found in DB',
		);
	if (target.roleSlug === OWNER_ROLE) throw forbidden('Instance owner cannot be deleted.');
	const personal = await findPersonalProject(db, target.id);
	if (!personal) throw notFound('Could not find a personal project for this user');
	if (transferId === personal.id) {
		throw badRequest(
			'Request to delete a user failed because the user to delete and the transferee are the same user',
		);
	}

	if (transferId) {
		if (!(await findProjectById(db, transferId))) {
			throw notFound(
				'Request to delete a user failed because the transferee project was not found in DB',
			);
		}
		await db.batch(transferStatements(db, personal.id, transferId));
	} else {
		await deleteOwnedResources(c, actor, personal.id);
	}

	await db.batch([
		db.prepare('DELETE FROM project WHERE id = ?').bind(personal.id),
		db.prepare('DELETE FROM user WHERE id = ?').bind(target.id),
	]);
	return ok(c, { success: true });
});

userRoutes.patch('/users/:id/role', async (c) => {
	const actor = requireUser(c);
	requireGlobalScope(actor, 'user:changeRole');
	const { newRoleName } = parseDto(RoleChangeRequestDto, await readJson(c));
	const db = c.env.DB;
	const id = c.req.param('id');
	if (actor.id === id) throw forbidden('Cannot change your own global role');
	const target = await findUserById(db, id);
	if (!target) throw notFound('Target user not found');
	if (actor.roleSlug === ADMIN_ROLE && target.roleSlug === OWNER_ROLE) {
		throw forbidden('Admin cannot change role on global owner');
	}
	if (actor.roleSlug === OWNER_ROLE && target.roleSlug === OWNER_ROLE) {
		throw forbidden('Owner cannot change role on global owner');
	}
	assertAssignable(newRoleName);

	const now = nowIso();
	const statements = [
		db
			.prepare('UPDATE user SET roleSlug = ?, updatedAt = ? WHERE id = ?')
			.bind(newRoleName, now, id),
	];
	const personal = await findPersonalProject(db, id);
	if (target.roleSlug !== CHAT_USER_ROLE && newRoleName === CHAT_USER_ROLE) {
		// Chat users keep only a viewer role on their personal project, like `UserService.changeUserRole`.
		const { results } = await db
			.prepare(
				`SELECT r.projectId, (SELECT COUNT(*) FROM project_relation o
					WHERE o.projectId = r.projectId AND o.userId <> r.userId AND o.role IN ('project:admin', 'project:personalOwner')) AS otherAdmins
				FROM project_relation r WHERE r.userId = ? AND r.role = 'project:admin'`,
			)
			.bind(id)
			.all<{ projectId: string; otherAdmins: number }>();
		const sole = results.find((row) => row.otherAdmins === 0);
		if (sole) {
			throw badRequest(
				`Cannot downgrade user as they are the only project admin in project "${sole.projectId}".`,
			);
		}
		statements.push(
			db
				.prepare('DELETE FROM project_relation WHERE userId = ? AND role <> ?')
				.bind(id, PERSONAL_OWNER_ROLE),
		);
		if (personal) {
			statements.push(
				db
					.prepare(
						'UPDATE project_relation SET role = ?, updatedAt = ? WHERE userId = ? AND projectId = ?',
					)
					.bind(PROJECT_VIEWER_ROLE, now, id, personal.id),
			);
		}
	} else if (target.roleSlug === CHAT_USER_ROLE && newRoleName !== CHAT_USER_ROLE && personal) {
		statements.push(
			db
				.prepare(
					'UPDATE project_relation SET role = ?, updatedAt = ? WHERE userId = ? AND projectId = ?',
				)
				.bind(PERSONAL_OWNER_ROLE, now, id, personal.id),
		);
	}
	await db.batch(statements);
	return ok(c, { success: true });
});
