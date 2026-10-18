import { parse, stringify } from 'flatted';
import type {
	ExecutionStatus,
	IRunExecutionData,
	IWorkflowBase,
	WorkflowExecuteMode,
} from 'n8n-workflow';

import type { ExecutionRow } from '../db/types';
import { nowIso } from '../db/types';
import type { Env } from '../env';
import type { ExecutionVars } from './config';
import { executionsConfig } from './config';

/** See docs/storage-layout.md. */
export const executionKeys = (id: string) => ({
	data: `executions/${id}/data.json`,
	workflow: `executions/${id}/workflow.json`,
	request: `executions/${id}/request.json`,
	webhook: `executions/${id}/webhook.json`,
});

export async function createExecution(
	env: Env,
	params: {
		workflowData: IWorkflowBase;
		mode: WorkflowExecuteMode;
		status?: ExecutionStatus;
		retryOf?: string;
		occurrenceKey?: string;
		/** Set when the caller already knows which runner takes the execution. */
		instanceId?: string;
		/** False when the runner writes the workflow snapshot itself, off the request path. */
		writeSnapshot?: boolean;
	},
): Promise<string> {
	const row = await env.DB.prepare(
		`INSERT INTO execution_entity (workflowId, mode, status, finished, retryOf, createdAt, workflowVersionId, instanceId, occurrenceKey)
		 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?) ON CONFLICT (occurrenceKey) DO UPDATE SET occurrenceKey = excluded.occurrenceKey RETURNING id`,
	)
		.bind(
			params.workflowData.id,
			params.mode,
			params.status ?? 'new',
			params.retryOf ?? null,
			nowIso(),
			params.workflowData.versionId ?? null,
			params.instanceId ?? null,
			params.occurrenceKey ?? null,
		)
		.first<{ id: number }>();
	if (!row) throw new Error('Could not create the execution');
	const id = String(row.id);
	if (params.writeSnapshot !== false) {
		await env.STORAGE.put(executionKeys(id).workflow, JSON.stringify(params.workflowData));
	}
	return id;
}

export async function getExecutionRow(env: Env, id: string): Promise<ExecutionRow | null> {
	return await env.DB.prepare('SELECT * FROM execution_entity WHERE id = ?')
		.bind(Number(id))
		.first<ExecutionRow>();
}

export async function updateExecution(
	env: Env,
	id: string,
	fields: Partial<
		Pick<
			ExecutionRow,
			| 'status'
			| 'finished'
			| 'startedAt'
			| 'stoppedAt'
			| 'waitTill'
			| 'instanceId'
			| 'retrySuccessId'
			| 'jsonSizeBytes'
		>
	>,
	opts: { requireNotCanceled?: boolean } = {},
): Promise<number> {
	const entries = Object.entries(fields);
	if (entries.length === 0) return 0;
	const sets = entries.map(([key]) => `${key} = ?`).join(', ');
	const guard = opts.requireNotCanceled ? " AND status != 'canceled'" : '';
	const result = await env.DB.prepare(`UPDATE execution_entity SET ${sets} WHERE id = ?${guard}`)
		.bind(...entries.map(([, value]) => value ?? null), Number(id))
		.run();
	return result.meta.changes;
}

export async function saveExecutionData(
	env: Env,
	id: string,
	data: IRunExecutionData,
): Promise<number> {
	const serialized = stringify(data);
	await env.STORAGE.put(executionKeys(id).data, serialized);
	return serialized.length;
}

export async function readExecutionDataString(env: Env, id: string): Promise<string | null> {
	const object = await env.STORAGE.get(executionKeys(id).data);
	return object ? await object.text() : null;
}

export async function loadExecutionData(
	env: Env,
	id: string,
): Promise<IRunExecutionData | undefined> {
	const text = await readExecutionDataString(env, id);
	return text ? (parse(text) as IRunExecutionData) : undefined;
}

export async function loadExecutionWorkflow(env: Env, id: string): Promise<IWorkflowBase | null> {
	const object = await env.STORAGE.get(executionKeys(id).workflow);
	return object ? await object.json<IWorkflowBase>() : null;
}

/** R2 deletes up to 1,000 keys in one call. */
const R2_DELETE_LIMIT = 1000;

export async function deleteExecutionsData(env: Env, ids: string[]): Promise<void> {
	const keys: string[] = [];
	const flush = async (all: boolean) => {
		while (keys.length >= (all ? 1 : R2_DELETE_LIMIT))
			await env.STORAGE.delete(keys.splice(0, R2_DELETE_LIMIT));
	};
	for (const id of ids) {
		// The runtime writes only these keys under executions/<id>/, so they need no list call.
		keys.push(...Object.values(executionKeys(id)));
		let cursor: string | undefined;
		do {
			const listed = await env.STORAGE.list({ prefix: `binary/${id}/`, cursor });
			keys.push(...listed.objects.map((object) => object.key));
			cursor = listed.truncated ? listed.cursor : undefined;
			await flush(false);
		} while (cursor);
	}
	await flush(true);
}

const HOUR_MS = 3_600_000;
/** Executions hard-deleted in one batch. */
const HARD_DELETE_BATCH = 100;
/**
 * Upper limit of batches in one cron run. Each execution costs about one R2 call, and a run has a
 * subrequest limit. With the cron every 15 minutes this deletes up to 192,000 executions a day.
 */
const HARD_DELETE_MAX_BATCHES = 20;
/** Time budget of one pruning run, so it ends well before the cron wall time limit. */
const PRUNE_BUDGET_MS = 60_000;

/** Port of ExecutionsPruningService: soft-delete old executions, then hard-delete them after the buffer. */
export async function pruneExecutions(env: Env & ExecutionVars, now = Date.now()): Promise<void> {
	const {
		pruneData,
		pruneDataMaxAge: maxAge,
		pruneDataMaxCount: maxCount,
		pruneDataHardDeleteBuffer: buffer,
	} = executionsConfig(env);
	if (!pruneData) return;
	const deadline = Date.now() + PRUNE_BUDGET_MS;
	// Stock softDeletePrunableExecutions: finished executions past the age, or older than the newest maxCount.
	const countCutoff =
		maxCount > 0
			? ' OR id <= (SELECT id FROM execution_entity ORDER BY id DESC LIMIT 1 OFFSET ?)'
			: '';
	await env.DB.prepare(
		`UPDATE execution_entity SET deletedAt = ? WHERE deletedAt IS NULL AND status NOT IN ('new', 'running', 'waiting')
		 AND (stoppedAt <= ?${countCutoff})`,
	)
		.bind(
			new Date(now).toISOString(),
			new Date(now - maxAge * HOUR_MS).toISOString(),
			...(maxCount > 0 ? [maxCount] : []),
		)
		.run();
	const hardDeleteBefore = new Date(now - buffer * HOUR_MS).toISOString();
	for (let batch = 0; batch < HARD_DELETE_MAX_BATCHES && Date.now() < deadline; batch++) {
		const { results } = await env.DB.prepare(
			'SELECT id FROM execution_entity WHERE deletedAt <= ? ORDER BY id LIMIT ?',
		)
			.bind(hardDeleteBefore, HARD_DELETE_BATCH)
			.all<{ id: number }>();
		if (results.length === 0) break;
		const ids = results.map(({ id }) => id);
		await deleteExecutionsData(env, ids.map(String));
		await env.DB.prepare(
			`DELETE FROM execution_entity WHERE id IN (${ids.map(() => '?').join(', ')})`,
		)
			.bind(...ids)
			.run();
		if (results.length < HARD_DELETE_BATCH) break;
	}
	if (Date.now() < deadline) await pruneTempBinaryData(env, now - buffer * HOUR_MS, deadline);
}

/**
 * A Webhook node writes uploads under the `temp` execution ID before the execution exists, and the
 * run moves them to its own ID when it ends or waits (restoreBinaryDataId). Files that are still
 * there belong to a run that never started or crashed. A file can still belong to an execution in
 * progress, so only files older than the oldest such execution are deleted.
 */
async function pruneTempBinaryData(env: Env, olderThan: number, deadline: number): Promise<void> {
	const active = await env.DB.prepare(
		"SELECT MIN(createdAt) AS createdAt FROM execution_entity WHERE status IN ('new', 'running')",
	).first<{ createdAt: string | null }>();
	// The upload happens before the execution row exists, so keep a margin.
	const cutoff = Math.min(
		olderThan,
		active?.createdAt ? Date.parse(active.createdAt) - HOUR_MS : Number.POSITIVE_INFINITY,
	);
	let cursor: string | undefined;
	do {
		const listed = await env.STORAGE.list({ prefix: 'binary/temp/', cursor });
		const stale = listed.objects
			.filter((object) => object.uploaded.getTime() < cutoff)
			.map((object) => object.key);
		if (stale.length > 0) await env.STORAGE.delete(stale);
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor && Date.now() < deadline);
}
