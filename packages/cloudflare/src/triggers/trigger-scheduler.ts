import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import { CronTime } from 'cron';
import type { ExecutionError, INode, INodeExecutionData, IWorkflowBase } from 'n8n-workflow';
import { loadWorkflow, toExecutionError } from '../execution/runner';
import { bootstrap } from '../runtime/bootstrap';
import type { RunContext } from '../runtime/service';
import { deleteTestRegistrations } from '../webhooks/test-webhooks';
import { pushHub } from '../push/push-hub';
import { saveStaticData, toWorkflow } from '../webhooks/workflow';
import { emitExecution, recordTriggerFailure, registerSchedules, runPoll } from './schedules';
import type { Schedule } from './schedules';

interface Configuration {
	workflowData: IWorkflowBase;
	baseUrl: string;
	generation: string;
}
type StoredSchedule = {
	id: number;
	node: string;
	kind: 'cron' | 'poll';
	ruleIndex: number;
	expression: string;
	timezone: string;
	nextFire: number;
};

interface Emission {
	node: INode;
	data: INodeExecutionData[][];
}
interface Occurrence {
	workflowData: IWorkflowBase;
	emissions: Emission[];
	/** Set when the poll failed. The occurrence is then handled as a failed trigger execution. */
	failure?: { node: INode; error: ExecutionError };
}

/** Delay before a failed occurrence handoff runs again. */
const HANDOFF_RETRY_MS = 10_000;

function nextFire(expression: string, timezone: string, after = Date.now()): number {
	return new CronTime(expression, timezone).getNextDateFrom(new Date(after), timezone).toMillis();
}

/** One instance per active workflow. Runs schedule and poll triggers from alarms. */
export class TriggerScheduler extends DurableObject<Env> {
	private initialize() {
		this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS schedules (
			id INTEGER PRIMARY KEY, node TEXT NOT NULL, kind TEXT NOT NULL, ruleIndex INTEGER NOT NULL,
			expression TEXT NOT NULL, timezone TEXT NOT NULL, nextFire INTEGER NOT NULL)`);
	}

	async configure(
		serializedWorkflow: string,
		baseUrl: string,
		schedules: Schedule[],
	): Promise<void> {
		await bootstrap(this.env);
		const workflowData: IWorkflowBase = JSON.parse(serializedWorkflow);
		const rows = schedules.map((schedule, id) => ({
			...schedule,
			id,
			nextFire: nextFire(schedule.expression, schedule.timezone),
		}));
		this.initialize();
		this.ctx.storage.sql.exec('DELETE FROM schedules');
		const stale = await this.ctx.storage.list({ prefix: 'occurrence:' });
		if (stale.size) await this.ctx.storage.delete([...stale.keys()]);
		for (const row of rows)
			this.ctx.storage.sql.exec(
				'INSERT INTO schedules VALUES (?, ?, ?, ?, ?, ?, ?)',
				row.id,
				row.node,
				row.kind,
				row.index,
				row.expression,
				row.timezone,
				row.nextFire,
			);
		await this.ctx.storage.put('configuration', {
			workflowData,
			baseUrl,
			generation: crypto.randomUUID(),
		} satisfies Configuration);
		await this.reschedule();
	}

	async expireTestWebhooks(workflowId: string, expiresAt: number): Promise<void> {
		await bootstrap(this.env);
		this.initialize();
		await this.ctx.storage.put('testExpiry', { workflowId, expiresAt });
		await this.reschedule();
	}

	async clear(): Promise<void> {
		await bootstrap(this.env);
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	async inspect(): Promise<{ alarm: number | null; schedules: StoredSchedule[] }> {
		await bootstrap(this.env);
		this.initialize();
		return {
			alarm: await this.ctx.storage.getAlarm(),
			schedules: this.ctx.storage.sql
				.exec<StoredSchedule>('SELECT * FROM schedules ORDER BY id')
				.toArray(),
		};
	}

	/** `retrying` rows keep their past nextFire until a handoff succeeds. They retry at `retryAt`. */
	private async reschedule(retrying = new Set<number>(), retryAt?: number): Promise<void> {
		this.initialize();
		const expiry = await this.ctx.storage.get<{ expiresAt: number }>('testExpiry');
		const rows = this.ctx.storage.sql
			.exec<{ id: number; nextFire: number }>('SELECT id, nextFire FROM schedules')
			.toArray()
			.filter((row) => !retrying.has(row.id));
		const times = [...rows.map((row) => row.nextFire), expiry?.expiresAt, retryAt].filter(
			(time): time is number => typeof time === 'number',
		);
		if (times.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...times)));
		else await this.ctx.storage.deleteAlarm();
	}

	/** False when configure() or clear() replaced the configuration that this alarm read. */
	private async isCurrent(generation: string): Promise<boolean> {
		const active = await this.ctx.storage.get<Configuration>('configuration');
		return active?.generation === generation;
	}

	async alarm(): Promise<void> {
		await bootstrap(this.env);
		this.initialize();
		const expiry = await this.ctx.storage.get<{ workflowId: string; expiresAt: number }>(
			'testExpiry',
		);
		if (expiry && expiry.expiresAt <= Date.now()) {
			const expired = await this.env.DB.prepare(
				'SELECT payload FROM test_webhook WHERE workflowId = ? AND expiresAt <= ? LIMIT 1',
			)
				.bind(expiry.workflowId, new Date().toISOString())
				.first<{ payload: string }>();
			const deleted = expired
				? await deleteTestRegistrations(this.env, expiry.workflowId, expired.payload)
				: undefined;
			if (deleted?.pushRef)
				await pushHub(this.env).send(
					{ type: 'testWebhookDeleted', data: { workflowId: expiry.workflowId } },
					deleted.pushRef,
				);
			const currentExpiry = await this.ctx.storage.get<{ expiresAt: number }>('testExpiry');
			if (currentExpiry?.expiresAt === expiry.expiresAt)
				await this.ctx.storage.delete('testExpiry');
		}
		const configuration = await this.ctx.storage.get<Configuration>('configuration');
		if (!configuration) {
			await this.reschedule();
			return;
		}
		const due = this.ctx.storage.sql
			.exec<StoredSchedule>('SELECT * FROM schedules WHERE nextFire <= ? ORDER BY id', Date.now())
			.toArray();
		if (!due.length) {
			await this.reschedule();
			return;
		}
		const current = await loadWorkflow(this.env, configuration.workflowData.id!);
		if (!current?.active) {
			await this.clear();
			return;
		}
		const workflowData = { ...configuration.workflowData, staticData: current.staticData };
		const workflow = await toWorkflow(workflowData);
		const rc: RunContext = { env: this.env, baseUrl: configuration.baseUrl, ctx: this.ctx };
		const emissions: Emission[] = [];
		const registered = await registerSchedules(rc, workflow, (node, data) =>
			emissions.push({ node, data }),
		);
		const { generation } = configuration;
		const retrying = new Set<number>();
		// Each row is handled on its own, so one failing occurrence does not hold back the others.
		for (const row of due) {
			const occurrenceKey = `occurrence:${generation}:${row.id}:${row.nextFire}`;
			const stored = await this.ctx.storage.get<string>(occurrenceKey);
			let occurrence: Occurrence;
			if (stored) occurrence = JSON.parse(stored);
			else {
				const node = workflow.getNode(row.node);
				if (!node) {
					console.error(`Scheduled node ${row.node} of workflow ${workflow.id} is missing`);
					if (!(await this.isCurrent(generation))) return;
					this.advance(row);
					continue;
				}
				let failure: Occurrence['failure'];
				if (row.kind === 'poll') {
					// Port of PollTriggerTaskHandler: a poll error is a handled occurrence. It becomes a
					// failed execution and runs the error workflow. The cursor does not move.
					try {
						const data = await runPoll(rc, workflow, node, (items) =>
							emissions.push({ node, data: items }),
						);
						if (data) emissions.push({ node, data });
					} catch (error) {
						emissions.splice(0);
						failure = { node, error: toExecutionError(error) };
					}
				} else
					registered
						.find((schedule) => schedule.node === row.node && schedule.index === row.ruleIndex)
						?.callback(new Date(row.nextFire));
				// JSON drops the observable proxy around static data, which storage cannot clone.
				const serialized = JSON.stringify({
					workflowData: failure
						? workflowData
						: { ...workflowData, staticData: workflow.staticData },
					emissions: emissions.splice(0),
					failure,
				} satisfies Occurrence);
				occurrence = JSON.parse(serialized);
				// A configure() during the poll replaced this configuration. Its output is stale.
				if (!(await this.isCurrent(generation))) return;
				// The occurrence is stored before its executions start. A retry after a failed
				// handoff starts the same executions again, and their occurrence keys make that a no-op.
				await this.ctx.storage.put(occurrenceKey, serialized);
			}
			try {
				if (occurrence.failure) {
					await recordTriggerFailure(
						rc,
						occurrence.workflowData,
						occurrence.failure.node,
						occurrence.failure.error,
						`${occurrenceKey}:error`,
					);
				}
				for (const [index, emission] of occurrence.emissions.entries()) {
					if (!(await this.isCurrent(generation))) return;
					await emitExecution(
						rc,
						occurrence.workflowData,
						emission.node,
						emission.data,
						`${occurrenceKey}:${index}`,
					);
				}
				if (!(await this.isCurrent(generation))) return;
				if (!occurrence.failure)
					await saveStaticData(this.env, await toWorkflow(occurrence.workflowData));
			} catch (error) {
				console.error(`Trigger of workflow ${workflow.id} failed, retrying`, error);
				retrying.add(row.id);
				continue;
			}
			if (!(await this.isCurrent(generation))) return;
			// Advance only after every execution of the occurrence is accepted. Like stock cron, skip missed fires.
			this.advance(row);
			await this.ctx.storage.delete(occurrenceKey);
		}
		await this.reschedule(retrying, retrying.size ? Date.now() + HANDOFF_RETRY_MS : undefined);
	}

	private advance(row: StoredSchedule): void {
		this.ctx.storage.sql.exec(
			'UPDATE schedules SET nextFire = ? WHERE id = ?',
			nextFire(row.expression, row.timezone, Math.max(row.nextFire, Date.now())),
			row.id,
		);
	}
}
