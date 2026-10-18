import type { Scope } from '@n8n/permissions';

import { resourceScopes } from '../auth/scopes';
import { projectAccessClause } from './access';
import type { ProjectAccess } from './access';
import { parseJson } from './types';
import type { ExecutionRow, UserRow } from './types';

export interface MetadataFilter {
	key: string;
	value: string;
	exactMatch?: boolean;
}

/** Filter keys stock n8n accepts in `filter` (see `schemaGetExecutionsQueryFilter`). */
export interface ExecutionFilter {
	workflowId?: string;
	status?: string[];
	mode?: string;
	finished?: boolean;
	waitTill?: boolean;
	retryOf?: string;
	retrySuccessId?: string;
	startedAfter?: string;
	startedBefore?: string;
	projectId?: string;
	workflowVersionId?: string;
	annotationTags?: string[];
	vote?: string;
	metadata?: MetadataFilter[];
}

export type ExecutionListRow = ExecutionRow & { workflowName: string | null };

const SELECT = `SELECT e.*, w.name AS workflowName FROM execution_entity e LEFT JOIN workflow_entity w ON w.id = e.workflowId`;

interface Where {
	sql: string;
	bindings: Array<string | number>;
}

function buildWhere(access: ProjectAccess, filter: ExecutionFilter, extra: Where[] = []): Where {
	const parts: string[] = ['e.deletedAt IS NULL'];
	const bindings: Array<string | number> = [];
	const add = (sql: string, ...values: Array<string | number>) => {
		parts.push(sql);
		bindings.push(...values);
	};

	if (!access.all) {
		const clause = projectAccessClause(access, 'sw.projectId', 'sw.role');
		add(
			`e.workflowId IN (SELECT sw.workflowId FROM shared_workflow sw WHERE ${clause.sql})`,
			...clause.bindings,
		);
	}
	if (filter.workflowId !== undefined) add('e.workflowId = ?', filter.workflowId);
	if (filter.status?.length)
		add('e.status IN (SELECT value FROM json_each(?))', JSON.stringify(filter.status));
	if (filter.mode !== undefined) add('e.mode = ?', filter.mode);
	if (filter.finished !== undefined) add('e.finished = ?', filter.finished ? 1 : 0);
	if (filter.waitTill !== undefined)
		add(filter.waitTill ? 'e.waitTill IS NOT NULL' : 'e.waitTill IS NULL');
	if (filter.retryOf !== undefined) add('e.retryOf = ?', filter.retryOf);
	if (filter.retrySuccessId !== undefined) add('e.retrySuccessId = ?', filter.retrySuccessId);
	if (filter.startedAfter !== undefined) add('e.startedAt >= ?', filter.startedAfter);
	if (filter.startedBefore !== undefined) add('e.startedAt <= ?', filter.startedBefore);
	if (filter.workflowVersionId !== undefined)
		add('e.workflowVersionId = ?', filter.workflowVersionId);
	if (filter.projectId !== undefined) {
		add(
			'e.workflowId IN (SELECT sw.workflowId FROM shared_workflow sw WHERE sw.projectId = ?)',
			filter.projectId,
		);
	}
	if (filter.vote !== undefined) {
		add(
			'EXISTS (SELECT 1 FROM execution_annotations a WHERE a.executionId = e.id AND a.vote = ?)',
			filter.vote,
		);
	}
	for (const tagId of filter.annotationTags ?? []) {
		add(
			`EXISTS (SELECT 1 FROM execution_annotations a JOIN execution_annotation_tags m ON m.annotationId = a.id
				WHERE a.executionId = e.id AND m.tagId = ?)`,
			tagId,
		);
	}
	for (const meta of filter.metadata ?? []) {
		add(
			`EXISTS (SELECT 1 FROM execution_metadata m WHERE m.executionId = e.id AND m.key = ? AND m.value ${
				meta.exactMatch === false ? 'LIKE ?' : '= ?'
			})`,
			meta.key,
			meta.exactMatch === false ? `%${meta.value}%` : meta.value,
		);
	}
	for (const e of extra) add(e.sql, ...e.bindings);
	return { sql: `WHERE ${parts.join(' AND ')}`, bindings };
}

export interface ExecutionPage {
	limit: number;
	/** Return rows with an id below this one. */
	beforeId?: number;
	/** Restrict to these statuses and ignore the status filter. */
	statuses?: string[];
	/** Sort executions in these statuses first. */
	runningFirst?: boolean;
}

export async function listExecutions(
	db: D1Database,
	access: ProjectAccess,
	filter: ExecutionFilter,
	page: ExecutionPage,
): Promise<ExecutionListRow[]> {
	const extra: Where[] = [];
	if (page.beforeId !== undefined) extra.push({ sql: 'e.id < ?', bindings: [page.beforeId] });
	const effective = page.statuses ? { ...filter, status: page.statuses } : filter;
	const where = buildWhere(access, effective, extra);
	const order = page.runningFirst ? "(e.status = 'running') DESC, e.id DESC" : 'e.id DESC';
	const { results } = await db
		.prepare(`${SELECT} ${where.sql} ORDER BY ${order} LIMIT ?`)
		.bind(...where.bindings, page.limit)
		.all<ExecutionListRow>();
	return results;
}

export async function countExecutions(
	db: D1Database,
	access: ProjectAccess,
	filter: ExecutionFilter,
	statuses?: string[],
): Promise<number> {
	const where = buildWhere(access, statuses ? { ...filter, status: statuses } : filter);
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM execution_entity e ${where.sql}`)
		.bind(...where.bindings)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** One execution if it belongs to a workflow the access covers. */
export async function findExecution(
	db: D1Database,
	access: ProjectAccess,
	id: number,
): Promise<ExecutionListRow | null> {
	const where = buildWhere(access, {}, [{ sql: 'e.id = ?', bindings: [id] }]);
	return await db
		.prepare(`${SELECT} ${where.sql}`)
		.bind(...where.bindings)
		.first<ExecutionListRow>();
}

export async function listExecutionIds(
	db: D1Database,
	access: ProjectAccess,
	filter: ExecutionFilter,
	extra: Where[] = [],
): Promise<number[]> {
	const where = buildWhere(access, filter, extra);
	const { results } = await db
		.prepare(`SELECT e.id FROM execution_entity e ${where.sql}`)
		.bind(...where.bindings)
		.all<{ id: number }>();
	return results.map((r) => r.id);
}

/** Every execution row of a workflow, including soft-deleted ones, because their data is still in R2. */
export async function workflowExecutionIds(db: D1Database, workflowId: string): Promise<number[]> {
	const { results } = await db
		.prepare('SELECT id FROM execution_entity WHERE workflowId = ?')
		.bind(workflowId)
		.all<{ id: number }>();
	return results.map((r) => r.id);
}

export async function deleteExecutionRows(db: D1Database, ids: number[]): Promise<void> {
	if (ids.length === 0) return;
	await db
		.prepare('DELETE FROM execution_entity WHERE id IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(ids))
		.run();
}

/** Scopes of the user on each workflow, from the project roles and sharing roles of the user. */
export async function workflowScopesById(
	db: D1Database,
	user: Pick<UserRow, 'id' | 'roleSlug'>,
	workflowIds: string[],
): Promise<Map<string, Scope[]>> {
	const out = new Map<string, Scope[]>();
	if (workflowIds.length === 0) return out;
	const [{ results: sharings }, { results: relations }] = await Promise.all([
		db
			.prepare(
				'SELECT workflowId, projectId, role FROM shared_workflow WHERE workflowId IN (SELECT value FROM json_each(?))',
			)
			.bind(JSON.stringify(workflowIds))
			.all<{ workflowId: string; projectId: string; role: string }>(),
		db
			.prepare('SELECT projectId, role FROM project_relation WHERE userId = ?')
			.bind(user.id)
			.all<{ projectId: string; role: string }>(),
	]);
	const roles = new Map(relations.map((r) => [r.projectId, r.role]));
	for (const id of workflowIds) {
		out.set(
			id,
			resourceScopes(
				user,
				'workflow',
				sharings.filter((s) => s.workflowId === id),
				roles,
			),
		);
	}
	return out;
}

export interface ExecutedVersion {
	versionId: string;
	name: string | null;
	createdAt: string;
}

export async function listExecutedVersions(
	db: D1Database,
	workflowId: string,
): Promise<ExecutedVersion[]> {
	const { results } = await db
		.prepare(
			`SELECT h.versionId, h.name, h.createdAt FROM workflow_history h
			WHERE h.workflowId = ? AND h.versionId IN (
				SELECT DISTINCT workflowVersionId FROM execution_entity WHERE workflowId = ? AND workflowVersionId IS NOT NULL)
			ORDER BY h.createdAt DESC`,
		)
		.bind(workflowId, workflowId)
		.all<ExecutedVersion>();
	return results;
}

export interface WorkflowSnapshotRow {
	id: string;
	name: string;
	active: number;
	isArchived: number;
	nodes: string;
	connections: string;
	settings: string | null;
	pinData: string | null;
	meta: string | null;
	versionId: string;
	activeVersionId: string | null;
	createdAt: string;
	updatedAt: string;
}

/** Fallback for executions without a stored snapshot: the current workflow. */
export async function findCurrentWorkflowSnapshot(db: D1Database, workflowId: string) {
	const row = await db
		.prepare(
			'SELECT id, name, active, isArchived, nodes, connections, settings, pinData, meta, versionId, activeVersionId, createdAt, updatedAt FROM workflow_entity WHERE id = ?',
		)
		.bind(workflowId)
		.first<WorkflowSnapshotRow>();
	if (!row) return null;
	return {
		id: row.id,
		name: row.name,
		active: row.active === 1,
		isArchived: row.isArchived === 1,
		nodes: parseJson<unknown[]>(row.nodes, []),
		connections: parseJson<Record<string, unknown>>(row.connections, {}),
		settings: parseJson<Record<string, unknown> | null>(row.settings, null),
		pinData: parseJson<Record<string, unknown> | null>(row.pinData, null),
		meta: parseJson<Record<string, unknown> | null>(row.meta, null),
		versionId: row.versionId,
		activeVersionId: row.activeVersionId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}
