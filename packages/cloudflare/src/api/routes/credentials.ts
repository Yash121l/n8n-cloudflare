import {
	CreateCredentialDto,
	CredentialsGetManyRequestQuery,
	CredentialsGetOneRequestQuery,
	GenerateCredentialNameRequestQuery,
	TestCredentialRequestDto,
} from '@n8n/api-types';
import { hasScope } from '@n8n/permissions';
import type { Scope } from '@n8n/permissions';
import { Hono } from 'hono';
import type { ICredentialDataDecryptedObject, IDataObject } from 'n8n-workflow';

import { requireUser } from '../../auth/middleware';
import { globalScopesOf } from '../../auth/scopes';
import { accessibleProjects } from '../../db/access';
import {
	credentialScopes,
	deleteCredential,
	findCredential,
	insertCredential,
	listCredentials,
	listCredentialsUsableInProject,
	loadSharings,
	uniqueCredentialName,
	updateCredential,
	userProjectRoles,
} from '../../db/credentials';
import type { CredentialSharing } from '../../db/credentials';
import { newId } from '../../db/ids';
import { findPersonalProject, findProjectById } from '../../db/projects';
import type { CredentialRow, UserRow } from '../../db/types';
import * as runtime from '../../runtime/service';
import { ok, runContextOf } from '../app';
import type { AppContext, AppEnv } from '../app';
import { redactCredentialData, unredactCredentialData } from '../credential-redaction';
import { badRequest, forbidden, notFound } from '../errors';
import { isRecord, jsonQueryParam, parseDto, queryParams, readJson, toInt } from '../http';
import { toProjectJson } from '../serializers';

export const credentialRoutes = new Hono<AppEnv>();

const DEFAULT_CREDENTIAL_NAME = 'My credentials';

interface Resolved {
	row: CredentialRow;
	sharings: CredentialSharing[];
	scopes: Scope[];
}

function serialize({ row, sharings, scopes }: Resolved, data?: ICredentialDataDecryptedObject) {
	const home = sharings.find((s) => s.role === 'credential:owner');
	return {
		id: row.id,
		name: row.name,
		type: row.type,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		isManaged: row.isManaged === 1,
		isGlobal: row.isGlobal === 1,
		isResolvable: false,
		usageScope: 'project' as const,
		homeProject: home ? toProjectJson(home.project) : undefined,
		sharedWithProjects: sharings.filter((s) => s !== home).map((s) => toProjectJson(s.project)),
		scopes,
		...(data ? { data } : {}),
	};
}

async function resolveMany(
	c: AppContext,
	user: UserRow,
	rows: CredentialRow[],
): Promise<Resolved[]> {
	const [sharings, relations] = await Promise.all([
		loadSharings(
			c.env.DB,
			rows.map((r) => r.id),
		),
		userProjectRoles(c.env.DB, user.id),
	]);
	return rows.map((row) => {
		const own = sharings.get(row.id) ?? [];
		return {
			row,
			sharings: own,
			scopes: credentialScopes(user, own, relations, row.isGlobal === 1),
		};
	});
}

async function resolveOne(
	c: AppContext,
	user: UserRow,
	id: string,
	required: Scope[],
): Promise<Resolved | null> {
	const row = await findCredential(c.env.DB, id);
	if (!row) return null;
	const [resolved] = await resolveMany(c, user, [row]);
	return required.every((scope) => resolved.scopes.includes(scope)) ? resolved : null;
}

/** Decrypts the stored data and blanks secret fields. The editor only ever sees the redacted form. */
async function decryptRedacted(
	c: AppContext,
	row: CredentialRow,
): Promise<ICredentialDataDecryptedObject> {
	const [data, props] = await Promise.all([
		runtime.decryptCredentialData(c.env, row.data),
		runtime.getCredentialProperties(row.type),
	]);
	const redacted = redactCredentialData(data, props);
	// The editor only checks that the value is truthy, and must never get the tokens.
	if (redacted.oauthTokenData) redacted.oauthTokenData = true;
	return redacted;
}

async function withData(
	c: AppContext,
	resolved: Resolved,
): Promise<ICredentialDataDecryptedObject | undefined> {
	return resolved.scopes.includes('credential:update')
		? await decryptRedacted(c, resolved.row)
		: undefined;
}

credentialRoutes.get('/credentials', async (c) => {
	const user = requireUser(c);
	const query = parseDto(CredentialsGetManyRequestQuery, queryParams(c));
	const params = queryParams(c);
	const filter = jsonQueryParam(params.filter);
	const filterRecord = isRecord(filter) ? filter : {};
	const take = params.take === undefined ? undefined : toInt(params.take, 20);

	const rows = await listCredentials(c.env.DB, user, {
		includeGlobal: query.includeGlobal,
		onlySharedWithMe: query.onlySharedWithMe ?? false,
		name: typeof filterRecord.name === 'string' ? filterRecord.name : undefined,
		type: typeof filterRecord.type === 'string' ? filterRecord.type : undefined,
		projectId: typeof filterRecord.projectId === 'string' ? filterRecord.projectId : undefined,
		skip: toInt(params.skip, 0),
		take,
	});
	const resolved = await resolveMany(c, user, rows);
	const items = await Promise.all(
		resolved.map(async (r) => serialize(r, query.includeData ? await withData(c, r) : undefined)),
	);
	return ok(c, items);
});

credentialRoutes.get('/credentials/for-workflow', async (c) => {
	const user = requireUser(c);
	const { workflowId, projectId } = queryParams(c);
	let scope: { workflowId: string } | { projectId: string };
	if (typeof workflowId === 'string') scope = { workflowId };
	else if (typeof projectId === 'string') scope = { projectId };
	else throw badRequest('workflowId or projectId is required');

	const rows = await listCredentialsUsableInProject(c.env.DB, scope);
	const resolved = (await resolveMany(c, user, rows)).filter((r) =>
		r.scopes.includes('credential:read'),
	);
	return ok(
		c,
		resolved.map((r) => ({
			...serialize(r),
			currentUserHasAccess: true,
			sharedRoute: 'project' as const,
		})),
	);
});

credentialRoutes.get('/credentials/new', async (c) => {
	requireUser(c);
	const { name } = parseDto(GenerateCredentialNameRequestQuery, queryParams(c));
	return ok(c, { name: await uniqueCredentialName(c.env.DB, name ?? DEFAULT_CREDENTIAL_NAME) });
});

credentialRoutes.post('/credentials/test', async (c) => {
	const user = requireUser(c);
	const { credentials } = parseDto(TestCredentialRequestDto, await readJson(c));
	const incoming = toCredentialData(credentials.data ?? {});

	const stored =
		credentials.id === '' ? null : await resolveOne(c, user, credentials.id, ['credential:read']);
	if (!stored) {
		const canTestUnsaved =
			credentials.id === '' &&
			hasScope('credential:manageInstance', { global: globalScopesOf(user.roleSlug) });
		if (!canTestUnsaved) throw forbidden();
		const result = await runtime.testCredentials(runContextOf(c), {
			id: credentials.id,
			name: credentials.name,
			type: credentials.type,
			data: incoming,
		});
		return ok(c, result);
	}

	if (credentials.type !== stored.row.type)
		throw badRequest('The credential type does not match the stored credential');

	// A reader may test the stored data only. Request data would let them aim the stored secrets at a URL they choose.
	const mayEdit = stored.scopes.includes('credential:update') && stored.row.isManaged !== 1;
	const [savedData, props] = await Promise.all([
		runtime.decryptCredentialData(c.env, stored.row.data),
		runtime.getCredentialProperties(stored.row.type),
	]);
	const data = mayEdit ? unredactCredentialData(incoming, savedData, props) : savedData;
	return ok(
		c,
		await runtime.testCredentials(runContextOf(c), {
			id: stored.row.id,
			name: mayEdit ? credentials.name || stored.row.name : stored.row.name,
			type: stored.row.type,
			data,
		}),
	);
});

credentialRoutes.get('/credentials/:credentialId', async (c) => {
	const user = requireUser(c);
	const id = c.req.param('credentialId');
	const { includeData } = parseDto(CredentialsGetOneRequestQuery, queryParams(c));
	const resolved = await resolveOne(c, user, id, ['credential:read']);
	if (!resolved) throw notFound(`Credential with ID "${id}" could not be found.`);
	return ok(c, serialize(resolved, includeData ? await withData(c, resolved) : undefined));
});

credentialRoutes.post('/credentials', async (c) => {
	const user = requireUser(c);
	const payload = parseDto(CreateCredentialDto, await readJson(c));

	let projectId = payload.projectId;
	if (projectId === undefined) {
		const personal = await findPersonalProject(c.env.DB, user.id);
		if (!personal) throw badRequest('Could not find the personal project of the user');
		projectId = personal.id;
	} else if (!(await findProjectById(c.env.DB, projectId))) {
		throw notFound('Project not found');
	}
	const access = await accessibleProjects(c.env.DB, user, 'credential:create');
	if (!access.all && !access.projectIds.includes(projectId)) {
		throw forbidden('You do not have permission to create credentials in this project');
	}
	if (
		payload.isGlobal === true &&
		!hasScope('credential:shareGlobally', { global: globalScopesOf(user.roleSlug) })
	) {
		throw forbidden('You do not have permission to create globally shared credentials');
	}

	const row = await insertCredential(
		c.env.DB,
		{
			id: newId(),
			name: payload.name,
			description: payload.description ?? null,
			data: await runtime.encryptCredentialData(c.env, toCredentialData(payload.data)),
			type: payload.type,
			isGlobal: payload.isGlobal === true ? 1 : 0,
		},
		projectId,
	);
	const [resolved] = await resolveMany(c, user, [row]);
	return ok(c, serialize(resolved));
});

const isDataObject = (value: unknown): value is IDataObject => isRecord(value);

/** Narrows the validated `Record<string, unknown>` body to credential data. */
function toCredentialData(data: Record<string, unknown>): ICredentialDataDecryptedObject {
	const out: ICredentialDataDecryptedObject = {};
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined || value === null) continue;
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
			out[key] = value;
		else if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
			out[key] = value.map(String);
		else if (Array.isArray(value) && value.every(isDataObject)) out[key] = value;
		else if (isDataObject(value)) out[key] = value;
		else throw badRequest(`Invalid value for credential field "${key}"`);
	}
	return out;
}

interface CredentialUpdate {
	name?: string;
	type?: string;
	description?: string | null;
	data?: Record<string, unknown>;
	isGlobal?: boolean;
}

function parseUpdate(body: Record<string, unknown>): CredentialUpdate {
	const update: CredentialUpdate = {};
	if (body.name !== undefined) {
		if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 128) {
			throw badRequest('name must be a string of 1 to 128 characters');
		}
		update.name = body.name;
	}
	if (body.type !== undefined) {
		if (typeof body.type !== 'string' || body.type.length < 1 || body.type.length > 128) {
			throw badRequest('type must be a string of 1 to 128 characters');
		}
		update.type = body.type;
	}
	if (body.description !== undefined) {
		if (body.description !== null && typeof body.description !== 'string') {
			throw badRequest('description must be a string');
		}
		update.description = body.description;
	}
	if (body.data !== undefined) {
		if (!isRecord(body.data)) throw badRequest('data must be an object');
		update.data = body.data;
	}
	if (body.isGlobal !== undefined) {
		if (typeof body.isGlobal !== 'boolean') throw badRequest('isGlobal must be a boolean');
		update.isGlobal = body.isGlobal;
	}
	return update;
}

credentialRoutes.patch('/credentials/:credentialId', async (c) => {
	const user = requireUser(c);
	const id = c.req.param('credentialId');
	const update = parseUpdate(await readJson(c));

	const resolved = await resolveOne(c, user, id, ['credential:update']);
	if (!resolved) {
		throw notFound(
			'Credential to be updated not found. You can only update credentials owned by you',
		);
	}
	if (resolved.row.isManaged === 1) throw badRequest('Managed credentials cannot be updated');
	if (update.isGlobal !== undefined && update.isGlobal !== (resolved.row.isGlobal === 1)) {
		if (!hasScope('credential:shareGlobally', { global: globalScopesOf(user.roleSlug) })) {
			throw forbidden('You do not have permission to change global sharing for credentials');
		}
	}

	let data: string | undefined;
	if (update.data) {
		const type = update.type ?? resolved.row.type;
		const [saved, props] = await Promise.all([
			runtime.decryptCredentialData(c.env, resolved.row.data),
			runtime.getCredentialProperties(type),
		]);
		// Users never change the OAuth token through this route, so the stored one is kept.
		const incoming = toCredentialData(update.data);
		delete incoming.oauthTokenData;
		const merged = unredactCredentialData(incoming, saved, props);
		if (saved.oauthTokenData && (update.type === undefined || update.type === resolved.row.type)) {
			merged.oauthTokenData = saved.oauthTokenData;
		}
		data = await runtime.encryptCredentialData(c.env, merged);
	}

	await updateCredential(c.env.DB, id, {
		name: update.name,
		type: update.type,
		description: update.description,
		data,
		isGlobal: update.isGlobal === undefined ? undefined : update.isGlobal ? 1 : 0,
	});
	const refreshed = await resolveOne(c, user, id, ['credential:update']);
	if (!refreshed) throw notFound(`Credential ID "${id}" could not be found to be updated.`);
	return ok(c, serialize(refreshed));
});

credentialRoutes.delete('/credentials/:credentialId/oauth-token', async (c) => {
	const user = requireUser(c);
	const id = c.req.param('credentialId');
	const resolved = await resolveOne(c, user, id, ['credential:update']);
	if (!resolved)
		throw notFound('Credential not found. You can only modify credentials you have access to.');
	if (resolved.row.isManaged === 1) throw badRequest('Managed credentials cannot be updated');

	const data = await runtime.decryptCredentialData(c.env, resolved.row.data);
	delete data.oauthTokenData;
	await updateCredential(c.env.DB, id, { data: await runtime.encryptCredentialData(c.env, data) });
	return ok(c, { success: true });
});

credentialRoutes.delete('/credentials/:credentialId', async (c) => {
	const user = requireUser(c);
	const id = c.req.param('credentialId');
	const resolved = await resolveOne(c, user, id, ['credential:delete']);
	if (!resolved) {
		throw notFound(
			'Credential to be deleted not found. You can only removed credentials owned by you',
		);
	}
	await deleteCredential(c.env.DB, id);
	return ok(c, true);
});
