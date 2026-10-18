import { Hono } from 'hono';
import type { IWorkflowBase } from 'n8n-workflow';
import type { AppEnv } from '../../src/api/app';
import type { UserRow } from '../../src/db/types';
import { loadWorkflow } from '../../src/execution/runner';
import {
	createExecution,
	executionKeys,
	loadExecutionData,
	pruneExecutions,
} from '../../src/execution/store';
import { runnerFor } from '../../src/execution/execution-runner';
import type { RunRequest } from '../../src/execution/runner';
import { encryptCredentialData, stopExecution } from '../../src/runtime/service';
import { bootstrap } from '../../src/runtime/bootstrap';
import { activateWorkflow, deactivateWorkflow } from '../../src/triggers/activation';
import { emitExecution } from '../../src/triggers/schedules';
import { webhookRoutes } from '../../src/webhooks/routes';
import { cancelTestWebhook, needsTestWebhook } from '../../src/webhooks/test-webhooks';

import type { Env } from '../../src/env';
import { ExecutionRunner as BaseRunner } from '../../src/execution/execution-runner';
import { TriggerScheduler as BaseScheduler } from '../../src/triggers/trigger-scheduler';
import {
	TriggerConnection as BaseConnection,
	triggerConnection,
} from '../../src/triggers/trigger-connection';

export { PushHub } from '../../src/push/push-hub';
export { ExecutionWorkflow } from '../../src/execution/execution-workflow';

/** Test controls of one runner. They change only what the runner sees from R2. */
interface RunnerControls {
	/** Delay of the read of the webhook response settings. It widens the gap between accept and run. */
	webhookConfigDelayMs: number;
	/** The next writes of a run request fail. */
	failRequestPuts: number;
}

const CONTROLS_KEY = 'test:controls';
const noControls: RunnerControls = { webhookConfigDelayMs: 0, failRequestPuts: 0 };

/** The controls live in Durable Object storage, so they survive a reset of the object. */
function controlledStorage(bucket: R2Bucket, storage: DurableObjectStorage): R2Bucket {
	const controls = async () => (await storage.get<RunnerControls>(CONTROLS_KEY)) ?? noControls;
	return new Proxy(bucket, {
		get(target, prop) {
			if (prop === 'get')
				return async (key: string, options?: R2GetOptions) => {
					const { webhookConfigDelayMs } = await controls();
					if (key.endsWith('/webhook.json') && webhookConfigDelayMs > 0)
						await new Promise((resolve) => setTimeout(resolve, webhookConfigDelayMs));
					return await target.get(key, options);
				};
			if (prop === 'put')
				return async (
					key: string,
					value: Parameters<R2Bucket['put']>[1],
					options?: R2PutOptions,
				) => {
					const current = await controls();
					if (key.endsWith('/request.json') && current.failRequestPuts > 0) {
						await storage.put(CONTROLS_KEY, {
							...current,
							failRequestPuts: current.failRequestPuts - 1,
						});
						throw new Error('Injected R2 write failure');
					}
					return await target.put(key, value, options);
				};
			const value: unknown = Reflect.get(target, prop);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

type Pending = { kind: string; due?: number; attempt?: number };

/** The production runner with probes. It counts alarms and can read or change its pending entries. */
export class ExecutionRunner extends BaseRunner {
	private alarms = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, {
			...env,
			STORAGE: controlledStorage(env.STORAGE, ctx.storage),
			CF_VERSION_METADATA: env.CF_VERSION_METADATA ?? {
				id: 'test',
				tag: 'test',
				timestamp: '2026-01-01T00:00:00.000Z',
			},
		});
	}

	override async alarm(): Promise<void> {
		this.alarms++;
		await super.alarm();
	}

	async probe() {
		return {
			alarms: this.alarms,
			alarm: await this.ctx.storage.getAlarm(),
			pending: Object.fromEntries(await this.ctx.storage.list<Pending>({ prefix: 'pending:' })),
		};
	}

	async control(controls: Partial<RunnerControls>): Promise<void> {
		const current = (await this.ctx.storage.get<RunnerControls>(CONTROLS_KEY)) ?? noControls;
		await this.ctx.storage.put(CONTROLS_KEY, { ...current, ...controls });
	}

	/** Lets the real alarm fire now. */
	async fireAlarm(): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now());
	}

	/** A fake clock for a timed wait: moves the wait and its pending entry to `due`, then lets the real alarm fire. */
	async advanceWait(executionId: string, due: number): Promise<void> {
		const pending = await this.ctx.storage.get<Pending>(`pending:${executionId}`);
		if (pending?.kind !== 'resume') throw new Error(`Execution ${executionId} has no timed wait`);
		await this.env.DB.prepare('UPDATE execution_entity SET waitTill = ? WHERE id = ?')
			.bind(new Date(due).toISOString(), Number(executionId))
			.run();
		await this.ctx.storage.put(`pending:${executionId}`, { kind: 'resume', due });
		await this.ctx.storage.setAlarm(due);
	}

	/** Runs `entry` as an alarm does that read it before another path changed the execution. */
	async runStaleEntry(executionId: string, entry: Pending): Promise<void> {
		const runner = this as unknown as { execute(id: string, entry: Pending): Promise<unknown> };
		await runner.execute(executionId, entry);
	}

	async versionCheck(callerTimestamp: string): Promise<void> {
		await this.ensureVersion(callerTimestamp);
	}
}

/** The production scheduler with probes. */
export class TriggerScheduler extends BaseScheduler {
	/** Makes every schedule due now and lets the real alarm fire. */
	async fireNow(): Promise<void> {
		this.ctx.storage.sql.exec('UPDATE schedules SET nextFire = ?', Date.now());
		await this.ctx.storage.setAlarm(Date.now());
	}

	/**
	 * Moves every schedule `ms` into the past, as if the object was down, then delivers the
	 * alarm twice at once, as an at-least-once retry can.
	 */
	async missFires(ms: number): Promise<void> {
		this.ctx.storage.sql.exec('UPDATE schedules SET nextFire = nextFire - ?', ms);
		await Promise.all([this.alarm(), this.alarm()]);
	}

	async occurrences(): Promise<string[]> {
		return [...(await this.ctx.storage.list({ prefix: 'occurrence:' })).keys()];
	}
}

/** The production trigger connection with probes. */
export class TriggerConnection extends BaseConnection {
	/** Lets the real watchdog alarm fire now. */
	async fireAlarm(): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now());
	}

	/** Resets the object as an eviction does: memory and open sockets go, storage and the alarm stay. */
	evict(): void {
		this.ctx.abort('test eviction');
	}
}

/**
 * Snowflake clients reach `https://<account>.snowflakecomputing.com`. An account named
 * `local-<port>` goes to the fake Snowflake server on that local port instead.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const href = input instanceof Request ? input.url : String(input);
	const local = /^https:\/\/local-(\d+)\.snowflakecomputing\.com(\/.*)?$/.exec(href);
	if (!local) return await realFetch(input, init);
	const request = new Request(input, init);
	return await realFetch(new Request(`http://127.0.0.1:${local[1]}${local[2] ?? '/'}`, request));
};

const app = new Hono<AppEnv>();
app.route('/', webhookRoutes);
app.onError((error, c) => c.json({ message: error.message }, 500));
app.post('/__test/register', async (c) => {
	const workflowData = await c.req.json<IWorkflowBase>();
	await bootstrap(c.env);
	const user = { id: 'test-user' } as UserRow;
	const registered = await needsTestWebhook(
		{ env: c.env, ctx: c.executionCtx, baseUrl: new URL(c.req.url).origin },
		{ workflowData, user, pushRef: 'test-ref' },
	);
	return c.json({ registered });
});
app.delete('/__test/register/:id', async (c) => {
	await cancelTestWebhook(c.env, c.req.param('id'));
	return c.json({ canceled: true });
});
app.post('/__test/activate/:id', async (c) => {
	await activateWorkflow(
		{ env: c.env, ctx: c.executionCtx, baseUrl: new URL(c.req.url).origin },
		c.req.param('id'),
	);
	return c.json({ active: true });
});
app.post('/__test/deactivate/:id', async (c) => {
	await deactivateWorkflow(
		{ env: c.env, ctx: c.executionCtx, baseUrl: new URL(c.req.url).origin },
		c.req.param('id'),
	);
	return c.json({ active: false });
});
app.get('/__test/schedule/:id', async (c) =>
	c.json(await c.env.TRIGGERS.get(c.env.TRIGGERS.idFromName(c.req.param('id'))).inspect()),
);
app.get('/__test/data/:id', async (c) => c.json(await loadExecutionData(c.env, c.req.param('id'))));
app.get('/__test/workflow/:id', async (c) => c.json(await loadWorkflow(c.env, c.req.param('id'))));
app.get('/__test/executions/:id', async (c) =>
	c.json(
		(
			await c.env.DB.prepare('SELECT * FROM execution_entity WHERE workflowId = ? ORDER BY id')
				.bind(c.req.param('id'))
				.all()
		).results,
	),
);
app.get(
	'/__test/push',
	async (c) => await c.env.PUSH.get(c.env.PUSH.idFromName('global')).fetch(c.req.raw),
);
app.post('/__test/expire/:id', async (c) => {
	const id = c.req.param('id');
	await c.env.TRIGGERS.get(c.env.TRIGGERS.idFromName(id)).expireTestWebhooks(id, Date.now() + 50);
	return c.json({ scheduled: true });
});
app.get('/__test/rss', async (c) => {
	const row = await c.env.DB.prepare("SELECT value FROM variables WHERE key = 'rss-date'").first<{
		value: string;
	}>();
	return c.body(
		`<?xml version="1.0"?><rss version="2.0"><channel><title>Local feed</title><link>https://example.com</link><description>Test feed</description>
		<item><title>Local item</title><guid>local-item</guid><pubDate>${new Date(row?.value ?? '2000-01-01').toUTCString()}</pubDate></item></channel></rss>`,
		200,
		{ 'content-type': 'application/rss+xml' },
	);
});

app.post('/__test/run', async (c) => {
	const input = await c.req.json<Omit<RunRequest, 'executionId' | 'baseUrl'>>();
	const executionId = await createExecution(c.env, {
		workflowData: input.workflowData,
		mode: input.executionMode,
	});
	await runnerFor(c.env, input.workflowData.id ?? executionId).start(executionId, {
		...input,
		executionId,
		baseUrl: new URL(c.req.url).origin,
	});
	return c.json({ executionId });
});
app.post('/__test/stop/:id', async (c) => {
	await stopExecution(
		{ env: c.env, ctx: c.executionCtx, baseUrl: new URL(c.req.url).origin },
		c.req.param('id'),
	);
	return c.json({ stopped: true });
});
app.get('/__test/request/:id', async (c) => {
	const request = await c.env.STORAGE.get(executionKeys(c.req.param('id')).request);
	return c.json(request ? await request.json() : null);
});
app.post('/__test/prune', async (c) => {
	const input = await c.req.json<{ now: number; maxCount?: string }>();
	await pruneExecutions({ ...c.env, EXECUTIONS_DATA_PRUNE_MAX_COUNT: input.maxCount }, input.now);
	return c.json({ pruned: true });
});
/** Hands the same occurrence over twice, as a scheduler retry after a lost reply does. */
app.post('/__test/emit/:id', async (c) => {
	const { key } = await c.req.json<{ key: string }>();
	const workflowData = await loadWorkflow(c.env, c.req.param('id'));
	if (!workflowData) return c.json({ message: 'missing workflow' }, 404);
	const rc = { env: c.env, ctx: c.executionCtx, baseUrl: new URL(c.req.url).origin };
	for (let attempt = 0; attempt < 2; attempt++) {
		await emitExecution(rc, workflowData, workflowData.nodes[0], [[{ json: { attempt } }]], key);
	}
	return c.json({ emitted: true });
});
/** Stores a credential and shares it and the workflow with one test project, so the workflow may use it. */
app.post('/__test/credential', async (c) => {
	const { id, type, data, workflowId } = await c.req.json<{
		id: string;
		type: string;
		data: Record<string, unknown>;
		workflowId: string;
	}>();
	await bootstrap(c.env);
	const now = new Date().toISOString();
	await c.env.DB.batch([
		c.env.DB.prepare(
			"INSERT OR IGNORE INTO project (id, name, type, createdAt, updatedAt) VALUES ('test-project', 'Test', 'team', ?, ?)",
		).bind(now, now),
		c.env.DB.prepare(
			'INSERT OR REPLACE INTO credentials_entity (id, name, data, type, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
		).bind(id, id, await encryptCredentialData(c.env, data as never), type, now, now),
		c.env.DB.prepare(
			"INSERT OR IGNORE INTO shared_credentials (credentialsId, projectId, role, createdAt, updatedAt) VALUES (?, 'test-project', 'credential:owner', ?, ?)",
		).bind(id, now, now),
		c.env.DB.prepare(
			"INSERT OR IGNORE INTO shared_workflow (workflowId, projectId, role, createdAt, updatedAt) VALUES (?, 'test-project', 'workflow:owner', ?, ?)",
		).bind(workflowId, now, now),
	]);
	return c.json({ id });
});
const connection = (c: { env: Env }, workflowId: string, node: string) =>
	triggerConnection(c.env, workflowId, node) as unknown as DurableObjectStub<TriggerConnection>;
app.get('/__test/connection/:id/:node', async (c) =>
	c.json(await connection(c, c.req.param('id'), c.req.param('node')).inspect()),
);
app.post('/__test/connection/:id/:node/fire-alarm', async (c) => {
	await connection(c, c.req.param('id'), c.req.param('node')).fireAlarm();
	return c.json({ ok: true });
});
app.post('/__test/connection/:id/:node/evict', async (c) => {
	try {
		await connection(c, c.req.param('id'), c.req.param('node')).evict();
	} catch {
		// abort() rejects the call that caused it.
	}
	return c.json({ ok: true });
});
const runner = (c: { env: Env }, workflowId: string) =>
	c.env.RUNNER.get(
		c.env.RUNNER.idFromName(workflowId),
	) as unknown as DurableObjectStub<ExecutionRunner>;
const scheduler = (c: { env: Env }, workflowId: string) =>
	c.env.TRIGGERS.get(
		c.env.TRIGGERS.idFromName(workflowId),
	) as unknown as DurableObjectStub<TriggerScheduler>;
app.get('/__test/runner/:id/probe', async (c) =>
	c.json(await runner(c, c.req.param('id')).probe()),
);
app.post('/__test/runner/:id/control', async (c) => {
	await runner(c, c.req.param('id')).control(await c.req.json<Partial<RunnerControls>>());
	return c.json({ ok: true });
});
app.post('/__test/runner/:id/fire-alarm', async (c) => {
	await runner(c, c.req.param('id')).fireAlarm();
	return c.json({ ok: true });
});
app.post('/__test/runner/:id/advance-wait', async (c) => {
	const { executionId, due } = await c.req.json<{ executionId: string; due: number }>();
	await runner(c, c.req.param('id')).advanceWait(executionId, due);
	return c.json({ ok: true });
});
app.post('/__test/runner/:id/stale-entry', async (c) => {
	const { executionId, entry } = await c.req.json<{ executionId: string; entry: Pending }>();
	await runner(c, c.req.param('id')).runStaleEntry(executionId, entry);
	return c.json({ ok: true });
});
app.post('/__test/runner/:id/version-check', async (c) => {
	const { timestamp } = await c.req.json<{ timestamp: string }>();
	try {
		await runner(c, c.req.param('id')).versionCheck(timestamp);
		return c.json({ reset: false });
	} catch {
		return c.json({ reset: true });
	}
});
app.post('/__test/scheduler/:id/fire', async (c) => {
	await scheduler(c, c.req.param('id')).fireNow();
	return c.json({ ok: true });
});
app.post('/__test/scheduler/:id/miss-fires', async (c) => {
	const { ms } = await c.req.json<{ ms: number }>();
	await scheduler(c, c.req.param('id')).missFires(ms);
	return c.json({ ok: true });
});
app.get('/__test/scheduler/:id/occurrences', async (c) =>
	c.json(await scheduler(c, c.req.param('id')).occurrences()),
);
app.get('/__test/r2', async (c) => {
	const listed = await c.env.STORAGE.list({ prefix: c.req.query('prefix') ?? '' });
	return c.json(listed.objects.map((object) => object.key));
});
app.post('/__test/r2', async (c) => {
	const { key } = await c.req.json<{ key: string }>();
	await c.env.STORAGE.put(key, 'leftover');
	return c.json({ ok: true });
});
/** RSS feed whose behavior a test sets in the `feed-<key>` variable: `fail`, `slow:<date>` or a date. */
app.get('/__test/feed/:key', async (c) => {
	const row = await c.env.DB.prepare('SELECT value FROM variables WHERE key = ?')
		.bind(`feed-${c.req.param('key')}`)
		.first<{ value: string }>();
	const value = row?.value ?? '2000-01-01';
	if (value === 'fail') return c.text('feed is down', 500);
	if (value.startsWith('slow:')) await new Promise((resolve) => setTimeout(resolve, 3000));
	const date = new Date(value.replace(/^slow:/, '')).toUTCString();
	return c.body(
		`<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><link>https://example.com</link><description>Test feed</description>
		<item><title>Item ${date}</title><guid>${date}</guid><pubDate>${date}</pubDate></item></channel></rss>`,
		200,
		{ 'content-type': 'application/rss+xml' },
	);
});
app.get('/__test/slow', async (c) => {
	await new Promise((resolve) => setTimeout(resolve, 2500));
	return c.json({ slow: true });
});

export default { fetch: app.fetch };
