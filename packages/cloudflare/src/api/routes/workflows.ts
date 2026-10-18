import { cancelTestWebhook } from '../../webhooks/test-webhooks';
import {
	ActivateWorkflowDto,
	ArchiveWorkflowDto,
	CreateWorkflowDto,
	DeactivateWorkflowDto,
	ListCallableSubworkflowsQueryDto,
	ManualRunDto,
	UpdateWorkflowDto,
} from '@n8n/api-types';
import { hasScope } from '@n8n/permissions';
import type { Scope } from '@n8n/permissions';
import { parse as parseFlatted } from 'flatted';
import { Hono } from 'hono';
import type { IWorkflowBase, IWorkflowSettings } from 'n8n-workflow';

import { requireUser } from '../../auth/middleware';
import { scopesForProject } from '../../auth/scopes';
import { workflowExecutionIds } from '../../db/executions';
import { PROJECT_ROOT, findFolderInProject, folderAndDescendantIds } from '../../db/folders';
import { findPersonalProject, findProjectById, userProjectRole } from '../../db/projects';
import { existingTagIds } from '../../db/tags';
import type { UserRow } from '../../db/types';
import {
	listFolderRows,
	listWorkflowRows,
	parseSortBy,
	readableActiveWorkflowIds,
	compareRows,
} from '../../db/workflow-list';
import type { ListRow, WorkflowListFilter } from '../../db/workflow-list';
import { findHistoryVersion, updateHistoryVersion } from '../../db/workflow-history';
import {
	deleteWorkflow,
	findWorkflowDocs,
	folderRefs,
	insertWorkflow,
	sharedForWorkflows,
	tagsForWorkflows,
	uniqueWorkflowName,
	updateWorkflowContent,
	userProjectRoles,
	workflowExists,
} from '../../db/workflows';
import type { WorkflowDoc } from '../../db/workflows';
import * as runtime from '../../runtime/service';
import type { AppContext, AppEnv } from '../app';
import { ok, runContextOf } from '../app';
import { HttpError, badRequest, conflict, notFound } from '../errors';
import { asBool, isRecord, jsonQueryParam, parseDto, queryParams, readJson, toInt } from '../http';
import {
	activate,
	activationError,
	archiveWorkflow,
	authorOf,
	deactivate,
	unarchiveWorkflow,
} from '../workflow-actions';
import {
	MISSING_SCOPE,
	addNodeIds,
	checksumOf,
	deepEqual,
	loadWorkflowAccess,
	ownership,
	requireWorkflow,
	serializeWorkflow,
	workflowScopes,
} from '../workflow-view';
import { folderListItems, folderRoutes } from './folders';
import { tagRoutes } from './tags';
import { workflowHistoryRoutes } from './workflow-history';

export const workflowRoutes = new Hono<AppEnv>();
workflowRoutes.route('/', tagRoutes);
workflowRoutes.route('/', folderRoutes);
workflowRoutes.route('/', workflowHistoryRoutes);

const MAX_PAGE_SIZE = 100;
const SELECTABLE_FIELDS = new Set([
	'id',
	'name',
	'active',
	'activeVersionId',
	'tags',
	'createdAt',
	'updatedAt',
	'versionId',
	'ownedBy',
	'parentFolder',
	'nodes',
	'isArchived',
	'description',
]);

const stringArray = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.every((v): v is string => typeof v === 'string')
		? value
		: undefined;

function parseListFilter(raw: unknown): WorkflowListFilter {
	if (raw === undefined) return {};
	if (!isRecord(raw)) throw badRequest('Invalid filter');
	const filter: WorkflowListFilter = {};
	if (stringArray(raw.ids)) filter.ids = stringArray(raw.ids);
	if (typeof raw.query === 'string') filter.query = raw.query;
	if (typeof raw.active === 'boolean') filter.active = raw.active;
	if (typeof raw.isArchived === 'boolean') filter.isArchived = raw.isArchived;
	if (stringArray(raw.tags)) filter.tags = stringArray(raw.tags);
	if (typeof raw.projectId === 'string') filter.projectId = raw.projectId;
	if (typeof raw.parentFolderId === 'string') filter.parentFolderId = raw.parentFolderId;
	if (stringArray(raw.nodeTypes)) filter.nodeTypes = stringArray(raw.nodeTypes);
	if (stringArray(raw.triggerNodeTypes))
		filter.triggerNodeTypes = stringArray(raw.triggerNodeTypes);
	return filter;
}

function parseSelect(raw: unknown): Set<string> | undefined {
	if (raw === undefined) return undefined;
	const fields = stringArray(raw);
	if (!fields) throw badRequest('Invalid select');
	const unknown = fields.filter((f) => !SELECTABLE_FIELDS.has(f));
	if (unknown.length > 0) throw badRequest(`Invalid select fields: ${unknown.join(', ')}`);
	return fields.length > 0 ? new Set(fields) : undefined;
}

function workflowListItem(
	doc: WorkflowDoc,
	user: UserRow,
	ctx: {
		tags: Map<string, unknown[]>;
		shared: Awaited<ReturnType<typeof sharedForWorkflows>>;
		folders: Awaited<ReturnType<typeof folderRefs>>;
		roles: Map<string, string>;
		select: Set<string> | undefined;
		includeScopes: boolean;
		includeFolders: boolean;
	},
): Record<string, unknown> {
	const shared = ctx.shared.get(doc.id) ?? [];
	const { homeProject, sharedWithProjects } = ownership(shared);
	const all: Record<string, unknown> = {
		id: doc.id,
		name: doc.name,
		description: doc.description,
		active: doc.active,
		isArchived: doc.isArchived,
		createdAt: doc.createdAt,
		updatedAt: doc.updatedAt,
		versionId: doc.versionId,
		activeVersionId: doc.activeVersionId,
		settings: doc.settings,
		nodes: doc.nodes,
		parentFolder: doc.parentFolderId ? (ctx.folders.get(doc.parentFolderId) ?? null) : null,
		tags: ctx.tags.get(doc.id) ?? [],
		homeProject,
		sharedWithProjects,
	};
	let item: Record<string, unknown>;
	if (ctx.select) {
		item = { id: doc.id };
		for (const field of ctx.select) {
			if (field === 'ownedBy') {
				item.homeProject = homeProject;
				item.sharedWithProjects = sharedWithProjects;
			} else {
				item[field] = all[field];
			}
		}
	} else {
		const { nodes: _nodes, ...rest } = all;
		item = rest;
	}
	if (ctx.includeScopes) item.scopes = workflowScopes(user, shared, ctx.roles);
	if (ctx.includeFolders) item.resource = 'workflow';
	return item;
}

async function pageItems(
	c: AppContext,
	user: UserRow,
	page: ListRow[],
	folderIds: Set<string>,
	opts: {
		select: Set<string> | undefined;
		includeScopes: boolean;
		includeFolders: boolean;
		isArchived?: boolean;
	},
) {
	const db = c.env.DB;
	const workflowRows = page.filter((row) => !folderIds.has(row.id));
	const docs = await findWorkflowDocs(
		db,
		workflowRows.map((r) => r.id),
	);
	const [tags, shared, roles] = await Promise.all([
		tagsForWorkflows(
			db,
			docs.map((d) => d.id),
		),
		sharedForWorkflows(
			db,
			docs.map((d) => d.id),
		),
		userProjectRoles(db, user.id),
	]);
	const folders = await folderRefs(
		db,
		docs.flatMap((d) => (d.parentFolderId ? [d.parentFolderId] : [])),
	);
	const docById = new Map(docs.map((d) => [d.id, d]));
	const folderItems = await folderListItems(
		db,
		page.filter((row) => folderIds.has(row.id)),
		{ isArchived: opts.isArchived },
	);
	const folderItemById = new Map(folderItems.map((item) => [String(item.id), item]));

	const items: Array<Record<string, unknown>> = [];
	for (const row of page) {
		if (folderIds.has(row.id)) {
			const folder = folderItemById.get(row.id);
			if (folder) items.push({ ...folder, resource: 'folder' });
			continue;
		}
		const doc = docById.get(row.id);
		if (doc) items.push(workflowListItem(doc, user, { tags, shared, folders, roles, ...opts }));
	}
	return items;
}

workflowRoutes.get('/workflows', async (c) => {
	const user = requireUser(c);
	const params = queryParams(c);
	const filter = parseListFilter(jsonQueryParam(params.filter));
	const select = parseSelect(jsonQueryParam(params.select));
	const includeScopes = asBool(params.includeScopes);
	const includeFolders = asBool(params.includeFolders);
	const onlySharedWithMe = asBool(params.onlySharedWithMe);
	const sortBy = typeof params.sortBy === 'string' ? params.sortBy : undefined;
	if (sortBy && !/^(name|createdAt|updatedAt):(asc|desc)$/.test(sortBy)) {
		throw badRequest('Invalid value for sortBy parameter');
	}

	if (params.take === undefined && params.skip !== undefined) {
		throw badRequest('Please specify `take` when using `skip`');
	}
	const take =
		params.take === undefined
			? undefined
			: Math.min(toInt(params.take, MAX_PAGE_SIZE), MAX_PAGE_SIZE);
	const skip = toInt(params.skip, 0);

	const db = c.env.DB;
	const personal = await findPersonalProject(db, user.id);
	const itemOptions = { select, includeScopes, includeFolders, isArchived: filter.isArchived };

	if (!includeFolders) {
		const { rows, count } = await listWorkflowRows(
			db,
			user,
			personal?.id ?? null,
			{ filter, sortBy, skip, take, onlySharedWithMe },
			'updatedAt:desc',
		);
		return c.json({ count, data: await pageItems(c, user, rows, new Set(), itemOptions) });
	}

	const workflowFilter = { ...filter };
	const folderFilter = { ...filter };
	if (
		filter.parentFolderId &&
		filter.parentFolderId !== PROJECT_ROOT &&
		filter.projectId &&
		filter.query
	) {
		const tree = await folderAndDescendantIds(db, filter.parentFolderId);
		workflowFilter.parentFolderIds = tree;
		workflowFilter.parentFolderId = undefined;
		folderFilter.folderIds = tree.filter((id) => id !== filter.parentFolderId);
		folderFilter.parentFolderId = undefined;
	}
	const { column, direction } = parseSortBy(sortBy, 'updatedAt:asc');
	const [workflows, folders] = await Promise.all([
		listWorkflowRows(
			db,
			user,
			personal?.id ?? null,
			{ filter: workflowFilter, sortBy: `${column}:${direction.toLowerCase()}`, onlySharedWithMe },
			'updatedAt:asc',
		),
		listFolderRows(db, user, folderFilter),
	]);
	const sortedFolders = [...folders].sort(compareRows(column, direction));
	const merged = [...sortedFolders, ...workflows.rows];
	const page = merged.slice(skip, take === undefined ? undefined : skip + take);
	const data = await pageItems(c, user, page, new Set(folders.map((f) => f.id)), itemOptions);
	return c.json({ count: workflows.count + folders.length, data });
});

workflowRoutes.post('/workflows/with-node-types', async (c) => {
	const user = requireUser(c);
	const body = await readJson(c);
	const nodeTypes = stringArray(body.nodeTypes) ?? [];
	const empty = () => c.json({ data: [], count: 0 });
	if (nodeTypes.length === 0) return empty();
	const { rows } = await listWorkflowRows(
		c.env.DB,
		user,
		null,
		{ filter: { nodeTypes, isArchived: false } },
		'updatedAt:desc',
	);
	const data = (
		await pageItems(c, user, rows, new Set(), {
			select: undefined,
			includeScopes: true,
			includeFolders: false,
		})
	).map((item) => ({ resourceType: 'workflow', ...item }));
	return c.json({ data, count: data.length });
});

async function projectWithScope(c: AppContext, user: UserRow, projectId: string, scope: Scope) {
	const project = await findProjectById(c.env.DB, projectId);
	if (!project) return null;
	const role = await userProjectRole(c.env.DB, user.id, project.id);
	return hasScope(scope, { global: scopesForProject(user, role) }) ? project : null;
}

workflowRoutes.get('/workflows/new', async (c) => {
	const user = requireUser(c);
	const params = queryParams(c);
	if (typeof params.projectId === 'string') {
		if (!(await projectWithScope(c, user, params.projectId, 'workflow:create'))) {
			throw new HttpError(
				403,
				"You don't have the permissions to create a workflow in this project.",
			);
		}
	}
	const requested =
		typeof params.name === 'string' && params.name !== '' ? params.name : 'My workflow';
	return ok(c, { name: await uniqueWorkflowName(c.env.DB, requested) });
});

workflowRoutes.get('/workflows/from-url', () => {
	throw badRequest('The URL does not point to valid JSON file!');
});

workflowRoutes.get('/active-workflows', async (c) => {
	const user = requireUser(c);
	return ok(c, await readableActiveWorkflowIds(c.env.DB, user));
});

workflowRoutes.get('/active-workflows/error/:id', (c) => {
	requireUser(c);
	return ok(c, undefined);
});

workflowRoutes.delete('/test-webhook/:workflowId', async (c) => {
	const user = requireUser(c);
	const workflowId = c.req.param('workflowId');
	await requireWorkflow(c.env.DB, user, workflowId, 'workflow:execute');
	await cancelTestWebhook(c.env, workflowId);
	return ok(c, true);
});

const emptyCounts = () => ({
	agentUsage: 0,
	credentialId: 0,
	dataTableId: 0,
	errorWorkflow: 0,
	errorWorkflowParent: 0,
	workflowCall: 0,
	workflowParent: 0,
});

workflowRoutes.post('/workflow-dependencies/counts', async (c) => {
	requireUser(c);
	const ids = stringArray((await readJson(c)).resourceIds) ?? [];
	return ok(c, Object.fromEntries(ids.map((id) => [id, emptyCounts()])));
});

workflowRoutes.post('/workflow-dependencies/details', async (c) => {
	requireUser(c);
	const ids = stringArray((await readJson(c)).resourceIds) ?? [];
	return ok(
		c,
		Object.fromEntries(ids.map((id) => [id, { dependencies: [], inaccessibleCount: 0 }])),
	);
});

workflowRoutes.get('/workflow-dependencies/projects/:projectId/folders/:folderId', (c) => {
	requireUser(c);
	return ok(c, []);
});

workflowRoutes.get('/workflows/:id', async (c) => {
	const user = requireUser(c);
	const access = await requireWorkflow(c.env.DB, user, c.req.param('id'), 'workflow:read');
	return ok(c, await serializeWorkflow(c.env.DB, access));
});

workflowRoutes.get('/workflows/:id/exists', async (c) => {
	requireUser(c);
	return ok(c, { exists: await workflowExists(c.env.DB, c.req.param('id')) });
});

workflowRoutes.get('/workflows/:id/collaboration/write-lock', async (c) => {
	const user = requireUser(c);
	await requireWorkflow(c.env.DB, user, c.req.param('id'), 'workflow:read');
	return ok(c, null);
});

workflowRoutes.get('/workflows/:id/publication-status', async (c) => {
	const user = requireUser(c);
	await requireWorkflow(c.env.DB, user, c.req.param('id'), 'workflow:read');
	throw notFound('Workflow publication status is not available');
});

workflowRoutes.get('/workflows/:id/callable-subworkflows', async (c) => {
	const user = requireUser(c);
	const id = c.req.param('id');
	await requireWorkflow(c.env.DB, user, id, 'workflow:update');
	const { query, skip, take } = parseDto(ListCallableSubworkflowsQueryDto, queryParams(c));
	const { rows, count } = await listWorkflowRows(
		c.env.DB,
		user,
		null,
		{ filter: { query, triggerNodeTypes: ['n8n-nodes-base.executeWorkflowTrigger'] }, skip, take },
		'updatedAt:desc',
	);
	const docs = await findWorkflowDocs(
		c.env.DB,
		rows.map((r) => r.id),
	);
	const byId = new Map(docs.map((d) => [d.id, d]));
	const data = rows.flatMap((row) => {
		const doc = byId.get(row.id);
		return doc
			? [
					{
						id: doc.id,
						name: doc.name,
						active: doc.activeVersionId !== null,
						isArchived: doc.isArchived,
					},
				]
			: [];
	});
	return ok(c, { count, data });
});

/** `executions/last-successful`: null when there is none or its data cannot be read. */
workflowRoutes.get('/workflows/:id/executions/last-successful', async (c) => {
	const user = requireUser(c);
	const id = c.req.param('id');
	await requireWorkflow(c.env.DB, user, id, 'workflow:read');
	const row = await c.env.DB.prepare(
		`SELECT id, mode, startedAt, stoppedAt, workflowId, jsonSizeBytes FROM execution_entity
			WHERE workflowId = ? AND status = 'success' AND deletedAt IS NULL ORDER BY id DESC LIMIT 1`,
	)
		.bind(id)
		.first<{
			id: number;
			mode: string;
			startedAt: string | null;
			stoppedAt: string | null;
			workflowId: string;
			jsonSizeBytes: number;
		}>();
	if (!row) return ok(c, null);
	try {
		const data = await runtime.readExecutionData(c.env, String(row.id));
		if (data === null) return ok(c, null);
		return ok(c, { ...row, id: String(row.id), data: parseFlatted(data) });
	} catch {
		return ok(c, null);
	}
});

function normalizeSettings(
	settings: IWorkflowSettings | null | undefined,
): IWorkflowSettings | null {
	if (!settings) return null;
	const cleaned: IWorkflowSettings = { ...settings };
	const keysAllowingDefault = [
		'errorWorkflow',
		'timezone',
		'saveDataErrorExecution',
		'saveDataSuccessExecution',
		'saveManualExecutions',
		'saveExecutionProgress',
	] as const;
	for (const key of keysAllowingDefault) {
		if (cleaned[key] === 'DEFAULT') delete cleaned[key];
	}
	if (cleaned.executionTimeout === -1) delete cleaned.executionTimeout;
	if (!cleaned.credentialResolverId) delete cleaned.credentialResolverId;
	return cleaned;
}

async function resolveFolder(
	c: AppContext,
	projectId: string,
	parentFolderId: string,
): Promise<string | null> {
	if (parentFolderId === PROJECT_ROOT) return null;
	if (!(await findFolderInProject(c.env.DB, parentFolderId, projectId))) {
		throw notFound(`Could not find the folder: ${parentFolderId}`);
	}
	return parentFolderId;
}

workflowRoutes.post('/workflows', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	const body = parseDto(CreateWorkflowDto, await readJson(c));
	if (body.id && (await workflowExists(db, body.id))) {
		throw badRequest(`Workflow with id ${body.id} exists already.`);
	}

	const projectId = body.projectId ?? (await findPersonalProject(db, user.id))?.id;
	if (!projectId) throw notFound('Project not found');
	if (!(await findProjectById(db, projectId))) throw notFound('Project not found');
	if (!(await projectWithScope(c, user, projectId, 'workflow:create'))) {
		throw badRequest("You don't have the permissions to save the workflow in this project.");
	}
	const parentFolderId = body.parentFolderId
		? await resolveFolder(c, projectId, body.parentFolderId)
		: null;

	const nodes = structuredClone(body.nodes);
	addNodeIds(nodes);
	const now = new Date().toISOString();
	const doc: WorkflowDoc = {
		id: body.id ?? crypto.randomUUID().replace(/-/g, '').slice(0, 16),
		name: body.name,
		description: body.description ?? null,
		active: false,
		isArchived: false,
		nodes,
		connections: body.connections,
		settings: body.settings ?? null,
		staticData: null,
		meta: body.meta ?? null,
		pinData: body.pinData ?? null,
		nodeGroups: body.nodeGroups ?? [],
		versionId: crypto.randomUUID(),
		activeVersionId: null,
		versionCounter: 1,
		triggerCount: 0,
		parentFolderId,
		createdAt: now,
		updatedAt: now,
	};
	const tagIds = body.tags ? await existingTagIds(db, body.tags) : [];
	await insertWorkflow(db, {
		doc,
		projectId,
		tagIds,
		authors: authorOf(user),
		autosaved: body.autosaved ?? false,
	});
	const access = await requireWorkflow(db, user, doc.id, 'workflow:read');
	return ok(c, await serializeWorkflow(db, access));
});

workflowRoutes.patch('/workflows/:id', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	const id = c.req.param('id');
	const forceSave = c.req.query('forceSave') === 'true';
	const body = parseDto(UpdateWorkflowDto, await readJson(c));
	const access = await requireWorkflow(db, user, id, 'workflow:update');
	const { doc: current } = access;

	if (current.isArchived) throw badRequest('Cannot update an archived workflow.');
	if (
		!forceSave &&
		body.expectedChecksum &&
		body.expectedChecksum !== (await checksumOf(current))
	) {
		throw conflict(
			'Your most recent changes may be lost, because someone else just updated this workflow. Open this workflow in a new tab to see those new updates.',
		);
	}
	if (body.settings && body.settings.timeSavedMode !== undefined) {
		if (!['fixed', 'dynamic'].includes(body.settings.timeSavedMode))
			throw badRequest('Invalid timeSavedMode');
	}

	const next: WorkflowDoc = { ...current };
	if (body.name !== undefined) next.name = body.name;
	if (body.description !== undefined) next.description = body.description;
	if (body.meta !== undefined) next.meta = body.meta;
	if (body.pinData !== undefined) next.pinData = body.pinData;
	if (body.nodes !== undefined) {
		next.nodes = structuredClone(body.nodes);
		addNodeIds(next.nodes);
	}
	if (body.connections !== undefined) next.connections = body.connections;
	if (body.nodeGroups !== undefined) next.nodeGroups = body.nodeGroups;

	const structureChanged =
		!deepEqual(next.nodes, current.nodes) ||
		!deepEqual(next.connections, current.connections) ||
		!deepEqual(next.nodeGroups, current.nodeGroups);
	next.versionId = structureChanged ? crypto.randomUUID() : current.versionId;

	if (body.settings !== undefined) {
		next.settings = normalizeSettings(
			current.settings ? { ...current.settings, ...body.settings } : body.settings,
		);
	}
	const settingsChanged =
		body.settings !== undefined && !deepEqual(next.settings, current.settings);

	if (body.parentFolderId) {
		const owner = access.shared.find((ref) => ref.role === 'workflow:owner');
		next.parentFolderId = await resolveFolder(c, owner?.projectId ?? '', body.parentFolderId);
	}
	next.updatedAt = new Date().toISOString();

	const tagIds = body.tags ? await existingTagIds(db, body.tags) : undefined;
	const saved = await updateWorkflowContent(db, current, {
		doc: next,
		tagIds: tagIds && body.tags ? body.tags.filter((tag) => tagIds.includes(tag)) : undefined,
		history: structureChanged
			? {
					versionId: next.versionId,
					workflowId: id,
					nodes: next.nodes,
					connections: next.connections,
					nodeGroups: next.nodeGroups,
					authors: authorOf(user),
					autosaved: body.autosaved ?? false,
				}
			: undefined,
	});
	if (!saved) throw conflictMessage();

	if (settingsChanged && current.activeVersionId) {
		try {
			await runtime.activateWorkflow(runContextOf(c), id);
		} catch (error) {
			throw activationError(error);
		}
	}

	const updated = await requireWorkflow(db, user, id, 'workflow:read');
	return ok(c, await serializeWorkflow(db, updated));
});

workflowRoutes.delete('/workflows/:id', async (c) => {
	const user = requireUser(c);
	const id = c.req.param('id');
	const { doc } = await requireWorkflow(c.env.DB, user, id, 'workflow:delete');
	if (!doc.isArchived) throw badRequest('Workflow must be archived before it can be deleted.');
	await deactivate(runContextOf(c), user, doc);
	// Data goes first. If R2 fails, the rows stay and a retry finds the same executions again.
	const executionIds = await workflowExecutionIds(c.env.DB, id);
	await runtime.deleteExecutionData(c.env, executionIds.map(String));
	await deleteWorkflow(c.env.DB, id);
	return ok(c, true);
});

workflowRoutes.post('/workflows/:id/archive', async (c) => {
	const user = requireUser(c);
	const id = c.req.param('id');
	const { expectedChecksum } = parseDto(ArchiveWorkflowDto, await readJson(c));
	const { doc } = await requireWorkflow(c.env.DB, user, id, 'workflow:delete');
	if (doc.isArchived) throw badRequest('Workflow is already archived.');
	if (expectedChecksum && expectedChecksum !== (await checksumOf(doc))) throw conflictMessage();
	await archiveWorkflow(runContextOf(c), user, doc);
	const access = await requireWorkflow(c.env.DB, user, id, 'workflow:read');
	return ok(c, await serializeWorkflow(c.env.DB, access));
});

workflowRoutes.post('/workflows/:id/unarchive', async (c) => {
	const user = requireUser(c);
	const id = c.req.param('id');
	const { doc } = await requireWorkflow(c.env.DB, user, id, 'workflow:delete');
	if (!doc.isArchived) throw badRequest('Workflow is not archived.');
	await unarchiveWorkflow(runContextOf(c), user, doc);
	const access = await requireWorkflow(c.env.DB, user, id, 'workflow:read');
	return ok(c, await serializeWorkflow(c.env.DB, access));
});

const conflictMessage = () =>
	conflict(
		'Your most recent changes may be lost, because someone else just updated this workflow. Open this workflow in a new tab to see those new updates.',
	);

workflowRoutes.post('/workflows/:id/activate', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	const id = c.req.param('id');
	const body = parseDto(ActivateWorkflowDto, await readJson(c));
	const access = await loadWorkflowAccess(db, user, id);
	if (!access) throw notFound(`Workflow with ID "${id}" not found.`);
	const { doc } = access;
	const canPublish = access.scopes.includes('workflow:publish');
	const canRepublish =
		body.versionId === doc.activeVersionId &&
		access.scopes.includes('workflow:read') &&
		access.scopes.includes('workflow:update');
	if (!canPublish && !canRepublish) throw new HttpError(403, MISSING_SCOPE);

	if (doc.isArchived) throw badRequest('Cannot activate an archived workflow.');
	const version = await findHistoryVersion(db, id, body.versionId);
	if (!version) throw notFound('Version not found');
	if (body.expectedChecksum && body.expectedChecksum !== (await checksumOf(doc)))
		throw conflictMessage();

	await activate(runContextOf(c), user, doc, body.versionId);
	if (body.name !== undefined || body.description !== undefined) {
		await updateHistoryVersion(db, id, body.versionId, {
			name: body.name,
			description: body.description,
		});
	}
	const updated = await requireWorkflow(db, user, id, 'workflow:read');
	return ok(c, await serializeWorkflow(db, updated));
});

workflowRoutes.post('/workflows/:id/deactivate', async (c) => {
	const user = requireUser(c);
	const db = c.env.DB;
	const id = c.req.param('id');
	const { expectedChecksum } = parseDto(DeactivateWorkflowDto, await readJson(c));
	const access = await requireWorkflow(db, user, id, 'workflow:unpublish');
	if (access.doc.activeVersionId !== null) {
		if (expectedChecksum && expectedChecksum !== (await checksumOf(access.doc)))
			throw conflictMessage();
		await deactivate(runContextOf(c), user, access.doc);
	}
	const updated = await requireWorkflow(db, user, id, 'workflow:read');
	return ok(c, await serializeWorkflow(db, updated));
});

workflowRoutes.post('/workflows/:id/run', async (c) => {
	const user = requireUser(c);
	const id = c.req.param('id');
	const access = await requireWorkflow(c.env.DB, user, id, 'workflow:execute');
	const parsed = ManualRunDto.safeParse(await readJson(c));
	if (!parsed.success) throw badRequest(parsed.error.errors[0]?.message ?? 'Invalid request');

	const { doc } = access;
	const workflowData: IWorkflowBase = {
		id: doc.id,
		name: doc.name,
		description: doc.description,
		active: doc.active,
		isArchived: doc.isArchived,
		createdAt: new Date(doc.createdAt),
		updatedAt: new Date(doc.updatedAt),
		nodes: doc.nodes,
		connections: doc.connections,
		settings: doc.settings ?? undefined,
		pinData: doc.pinData ?? undefined,
		versionId: doc.versionId,
		activeVersionId: doc.activeVersionId,
		versionCounter: doc.versionCounter,
		nodeGroups: doc.nodeGroups,
	};
	const result = await runtime.runManualExecution(
		runContextOf(c),
		{ ...parsed.data, workflowData },
		user,
		c.req.header('push-ref'),
	);
	return ok(c, result);
});
