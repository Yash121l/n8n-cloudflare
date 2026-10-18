import { DeleteExecutionsDto } from '@n8n/api-types';
import { stringify } from 'flatted';
import { Hono } from 'hono';
import { ExecutionStatusList } from 'n8n-workflow';

import { requireUser } from '../../auth/middleware';
import { accessibleProjects } from '../../db/access';
import { annotateExecution, countAnnotationTags, findAnnotations } from '../../db/annotations';
import type { ExecutionAnnotation } from '../../db/annotations';
import {
	countExecutions,
	deleteExecutionRows,
	findCurrentWorkflowSnapshot,
	findExecution,
	listExecutedVersions,
	listExecutionIds,
	listExecutions,
	workflowScopesById,
} from '../../db/executions';
import type { ExecutionFilter, ExecutionListRow } from '../../db/executions';
import * as runtime from '../../runtime/service';
import { ok, runContextOf } from '../app';
import type { AppContext, AppEnv } from '../app';
import { badRequest, conflict, notFound } from '../errors';
import { isRecord, jsonQueryParam, parseDto, queryParams, readJson, toInt } from '../http';

export const executionRoutes = new Hono<AppEnv>();

const CURRENT_STATUSES = ['new', 'running'];
const COMPLETED_STATUSES = ExecutionStatusList.filter((s) => !CURRENT_STATUSES.includes(s));
const STOPPABLE_STATUSES = ['new', 'unknown', 'waiting', 'running'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const toBase64Url = (text: string) =>
	btoa(String.fromCharCode(...new TextEncoder().encode(text)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

const fromBase64Url = (value: string) => {
	const padded = value
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');
	return new TextDecoder().decode(Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0)));
};

/** Same wire format as stock n8n: base64url of `{ version: 1, v1: { id, timestamp } }`. */
function encodeCursor(row: ExecutionListRow): string {
	return toBase64Url(
		JSON.stringify({
			version: 1,
			v1: { id: String(row.id), timestamp: new Date(row.startedAt ?? row.createdAt).toISOString() },
		}),
	);
}

function decodeCursor(value: string | string[] | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(value)) {
		throw badRequest('Invalid execution cursor');
	}
	try {
		const parsed: unknown = JSON.parse(fromBase64Url(value));
		if (isRecord(parsed) && isRecord(parsed.v1) && typeof parsed.v1.id === 'string') {
			const id = Number(parsed.v1.id);
			if (Number.isInteger(id) && id > 0) return id;
		}
		if (isRecord(parsed) && parsed.v1 === undefined) return undefined;
	} catch {
		// Fall through to the error below.
	}
	throw badRequest('Invalid execution cursor');
}

function isMetadata(value: unknown): value is { key: string; value: string; exactMatch?: boolean } {
	return (
		isRecord(value) &&
		typeof value.key === 'string' &&
		typeof value.value === 'string' &&
		(value.exactMatch === undefined || typeof value.exactMatch === 'boolean')
	);
}

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((v) => typeof v === 'string');

/** Reads the allowed filter keys and rejects values of the wrong type, like the stock JSON schema. */
function parseFilter(raw: unknown): ExecutionFilter {
	if (raw === undefined) return {};
	if (!isRecord(raw)) throw badRequest('Query does not match schema');
	const filter: ExecutionFilter = {};
	const text = (key: string) => {
		const value = raw[key];
		if (value === undefined) return undefined;
		if (typeof value === 'string') return value;
		if (typeof value === 'number' && key === 'workflowId') return String(value);
		throw badRequest('Query does not match schema');
	};
	filter.workflowId = text('workflowId');
	filter.mode = text('mode');
	filter.retryOf = text('retryOf');
	filter.retrySuccessId = text('retrySuccessId');
	filter.startedAfter = text('startedAfter');
	filter.startedBefore = text('startedBefore');
	filter.projectId = text('projectId');
	filter.workflowVersionId = text('workflowVersionId');
	filter.vote = text('vote');
	if (raw.annotationTags !== undefined) {
		if (!isStringList(raw.annotationTags)) throw badRequest('Query does not match schema');
		filter.annotationTags = raw.annotationTags;
	}
	if (raw.status !== undefined) {
		if (!isStringList(raw.status)) throw badRequest('Query does not match schema');
		filter.status = raw.status;
	}
	if (typeof raw.finished === 'boolean') filter.finished = raw.finished;
	if (typeof raw.waitTill === 'boolean') filter.waitTill = raw.waitTill;
	if (raw.metadata !== undefined) {
		if (!Array.isArray(raw.metadata) || !raw.metadata.every(isMetadata)) {
			throw badRequest('Query does not match schema');
		}
		filter.metadata = raw.metadata;
	}
	return filter;
}

function summary(
	row: ExecutionListRow,
	scopes: string[],
	annotation: ExecutionAnnotation | undefined,
) {
	return {
		id: String(row.id),
		finished: row.finished === 1,
		mode: row.mode,
		retryOf: row.retryOf,
		retrySuccessId: row.retrySuccessId,
		waitTill: row.waitTill ?? undefined,
		createdAt: row.createdAt,
		startedAt: row.startedAt,
		stoppedAt: row.stoppedAt ?? undefined,
		workflowId: row.workflowId,
		workflowName: row.workflowName ?? undefined,
		workflowVersionId: row.workflowVersionId,
		status: row.status,
		jsonSizeBytes: row.jsonSizeBytes,
		annotation: { vote: annotation?.vote ?? null, tags: annotation?.tags ?? [] },
		scopes,
	};
}

function parseExecutionId(value: string): number {
	if (!/^[1-9]\d*$/.test(value) || Number(value) > Number.MAX_SAFE_INTEGER) {
		throw badRequest('Execution ID is not valid');
	}
	return Number(value);
}

executionRoutes.get('/executions', async (c) => {
	const user = requireUser(c);
	const params = queryParams(c);
	if (params.firstId !== undefined || params.lastId !== undefined) {
		throw badRequest(
			'Use cursor to load execution pages. Your n8n instance has most likely updated. Please refresh the page.',
		);
	}
	const limit = params.limit === undefined ? DEFAULT_LIMIT : Number(params.limit);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw badRequest('Execution limit must be between 1 and 100');
	}
	const filter = parseFilter(jsonQueryParam(params.filter));
	const beforeId = decodeCursor(params.cursor);

	const access = await accessibleProjects(c.env.DB, user, 'execution:read', 'workflow');
	if (!access.all && access.projectIds.length === 0) {
		return ok(c, {
			results: [],
			nextCursor: null,
			count: 0,
			estimated: false,
			concurrentExecutionsCount: -1,
		});
	}

	// Without a status filter the first page shows the running executions on top of a completed-only page.
	const combines = !filter.status?.length;
	const completedStatuses = combines ? COMPLETED_STATUSES : undefined;
	const completed = await listExecutions(c.env.DB, access, filter, {
		limit,
		beforeId,
		statuses: completedStatuses,
	});
	const current =
		combines && beforeId === undefined
			? await listExecutions(c.env.DB, access, filter, {
					limit,
					statuses: CURRENT_STATUSES,
					runningFirst: true,
				})
			: [];
	const count = await countExecutions(c.env.DB, access, filter, completedStatuses);

	const rows = [...current, ...completed];
	const scopes = await workflowScopesById(c.env.DB, user, [
		...new Set(rows.map((r) => r.workflowId)),
	]);
	const annotations = await findAnnotations(
		c.env.DB,
		rows.map((r) => r.id),
	);
	const last = completed[completed.length - 1];
	return ok(c, {
		results: rows.map((row) =>
			summary(row, scopes.get(row.workflowId) ?? [], annotations.get(row.id)),
		),
		nextCursor: completed.length >= limit && last ? encodeCursor(last) : null,
		count,
		estimated: false,
		concurrentExecutionsCount: -1,
	});
});

executionRoutes.get('/executions/versions/:workflowId', async (c) => {
	const user = requireUser(c);
	const workflowId = c.req.param('workflowId');
	const access = await accessibleProjects(c.env.DB, user, 'execution:read', 'workflow');
	const visible = await listExecutionIds(c.env.DB, access, { workflowId }, []);
	if (visible.length === 0) return ok(c, []);
	return ok(c, await listExecutedVersions(c.env.DB, workflowId));
});

async function loadOne(c: AppContext, scope: 'execution:read' | 'workflow:execute') {
	const user = requireUser(c);
	const id = parseExecutionId(c.req.param('id') ?? '');
	const access = await accessibleProjects(c.env.DB, user, scope, 'workflow');
	return { user, access, id, row: await findExecution(c.env.DB, access, id) };
}

const emptyRunData = () => stringify({ version: 1, startData: {}, resultData: { runData: {} } });

async function executionDetail(c: AppContext, id: number, row: ExecutionListRow) {
	const executionId = String(id);
	const stored = await runtime.readExecutionData(c.env, executionId);
	// Running executions have no stored data yet. Finished ones without data are gone, as in stock n8n.
	if (stored === null && !CURRENT_STATUSES.includes(row.status) && row.status !== 'waiting') {
		throw notFound(
			'Data for this execution is unavailable. It may have already been deleted based on your data retention settings.',
		);
	}
	const workflowData =
		(await runtime.readExecutionWorkflow(c.env, executionId)) ??
		(await findCurrentWorkflowSnapshot(c.env.DB, row.workflowId));
	if (!workflowData) throw notFound('Workflow of this execution no longer exists');
	const annotation = (await findAnnotations(c.env.DB, [id])).get(id);

	return {
		id: executionId,
		finished: row.finished === 1,
		mode: row.mode,
		retryOf: row.retryOf,
		retrySuccessId: row.retrySuccessId,
		status: row.status,
		createdAt: row.createdAt,
		startedAt: row.startedAt,
		stoppedAt: row.stoppedAt ?? undefined,
		waitTill: row.waitTill ?? undefined,
		workflowId: row.workflowId,
		workflowData,
		data: stored ?? emptyRunData(),
		...(annotation && { annotation }),
	};
}

executionRoutes.get('/executions/:id', async (c) => {
	const { row, id } = await loadOne(c, 'execution:read');
	if (!row) return ok(c, undefined);
	return ok(c, await executionDetail(c, id, row));
});

/** Stops one execution. The runtime cancels the run, then the row decides what the editor sees. */
async function stopOne(c: AppContext, id: number, row: ExecutionListRow) {
	if (!STOPPABLE_STATUSES.includes(row.status)) {
		throw badRequest(
			`Only running or waiting executions can be stopped and ${id} is currently ${row.status}`,
		);
	}
	await runtime.stopExecution(runContextOf(c), String(id));
}

executionRoutes.post('/executions/stopMany', async (c) => {
	const user = requireUser(c);
	const body = await readJson(c);
	const filter = parseFilter(isRecord(body.filter) ? body.filter : undefined);
	const access = await accessibleProjects(c.env.DB, user, 'workflow:execute', 'workflow');
	if (!access.all && access.projectIds.length === 0) return ok(c, { stopped: 0 });

	const ids = await listExecutionIds(c.env.DB, access, {
		...filter,
		status: filter.status ?? STOPPABLE_STATUSES,
	});
	let stopped = 0;
	for (const id of ids) {
		const row = await findExecution(c.env.DB, access, id);
		if (!row) continue;
		try {
			await stopOne(c, id, row);
			stopped++;
		} catch (error) {
			console.warn(`Could not stop execution ${id}`, error);
		}
	}
	return ok(c, { stopped });
});

executionRoutes.post('/executions/delete', async (c) => {
	const user = requireUser(c);
	const payload = parseDto(DeleteExecutionsDto, await readJson(c));
	// Like stock, filters alone never select executions. They only narrow a delete by date.
	if (!payload.ids && !payload.deleteBefore) {
		throw badRequest('Either "deleteBefore" or "ids" must be present in the request body');
	}
	const access = await accessibleProjects(c.env.DB, user, 'execution:delete', 'workflow');
	if (!access.all && access.projectIds.length === 0) throw notFound('Execution not found');

	// A running execution is owned by its runner, so its row stays. Stock refuses to delete a single running one too.
	const extra: Array<{ sql: string; bindings: Array<string | number> }> = [
		{ sql: "e.status != 'running'", bindings: [] },
	];
	let filter: ExecutionFilter = {};
	if (payload.deleteBefore) {
		extra.push({
			sql: 'COALESCE(e.startedAt, e.createdAt) <= ?',
			bindings: [payload.deleteBefore.toISOString()],
		});
		filter = parseFilter(payload.filters);
	} else if (payload.ids) {
		extra.push({
			sql: 'e.id IN (SELECT value FROM json_each(?))',
			bindings: [JSON.stringify(payload.ids.map(Number))],
		});
	}
	const ids = await listExecutionIds(c.env.DB, access, filter, extra);
	if (ids.length > 0) {
		await runtime.deleteExecutionData(c.env, ids.map(String));
		await deleteExecutionRows(c.env.DB, ids);
	}
	return ok(c, undefined);
});

executionRoutes.post('/executions/:id/stop', async (c) => {
	const { row, id } = await loadOne(c, 'workflow:execute');
	if (!row) throw notFound('Failed to find execution to stop');
	await stopOne(c, id, row);
	const after = (await findExecution(c.env.DB, { all: true }, id)) ?? row;
	return ok(c, {
		mode: after.mode,
		startedAt: after.startedAt ?? after.createdAt,
		stoppedAt: after.stoppedAt ?? undefined,
		finished: after.finished === 1,
		status: after.status,
	});
});

const RETRYABLE_STATUSES = ['error', 'crashed'];

executionRoutes.post('/executions/:id/retry', async (c) => {
	const { user, row, id } = await loadOne(c, 'workflow:execute');
	if (!row) throw notFound(`The execution with the ID "${c.req.param('id')}" does not exist.`);
	if (row.status === 'new')
		throw badRequest('Execution is queued to run (not yet started) so it cannot be retried');
	if (row.finished === 1) throw conflict('The execution succeeded, so it cannot be retried.');
	if (!RETRYABLE_STATUSES.includes(row.status)) {
		throw conflict(`Only failed executions can be retried and ${id} is currently ${row.status}`);
	}
	const body = await readJson(c);
	const { executionId, run, workflowData } = await runtime.retryExecution(
		runContextOf(c),
		user,
		{ id: String(id), workflowId: row.workflowId },
		{ loadWorkflow: body.loadWorkflow === true },
	);
	const annotation = (await findAnnotations(c.env.DB, [id])).get(id);
	return ok(c, {
		id: executionId,
		mode: run.mode,
		startedAt: run.startedAt,
		workflowId: row.workflowId,
		finished: run.status === 'success',
		retryOf: String(id),
		status: run.status,
		waitTill: run.waitTill,
		data: stringify(run.data),
		workflowData,
		...(annotation && { annotation }),
	});
});

executionRoutes.patch('/executions/:id', async (c) => {
	const { row, id } = await loadOne(c, 'execution:read');
	if (!row) throw notFound('Execution not found');
	const body = await readJson(c);
	const { tags, vote } = body;
	if (tags !== undefined && !isStringList(tags))
		throw badRequest('tags must be an array of strings');
	if (vote !== undefined && vote !== null && vote !== 'up' && vote !== 'down') {
		throw badRequest("vote must be 'up', 'down' or null");
	}
	if (!tags && vote === undefined) throw badRequest('No annotation provided');
	const distinct = tags ? [...new Set(tags)] : [];
	if (distinct.length > 0 && (await countAnnotationTags(c.env.DB, distinct)) !== distinct.length) {
		throw notFound('Some tags not found');
	}
	await annotateExecution(c.env.DB, id, { vote, tags });
	return ok(c, await executionDetail(c, id, row));
});
