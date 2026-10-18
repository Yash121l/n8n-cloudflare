import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IWorkflowBase } from 'n8n-workflow';
import { startInstance } from '../api/harness';
import type { Instance } from '../api/harness';
import { execDb, literal } from '../api/sql';
import {
	activate,
	eventually,
	executions,
	node,
	seed,
	setNode,
	workflow,
} from '../webhooks/fixtures';

interface Schedule {
	alarm: number | null;
	schedules: Array<{ node: string; nextFire: number }>;
}

describe('poll failures and reconfiguration', () => {
	let instance: Instance;
	const feed = (name: string, key: string) =>
		node(name, 'rssFeedReadTrigger', {
			feedUrl: `${instance.origin}/__test/feed/${key}`,
			pollTimes: { item: [{ mode: 'everyMinute' }] },
		});
	const setFeed = (key: string, value: string) =>
		execDb(
			instance,
			`DELETE FROM variables WHERE key = ${literal(`feed-${key}`)}; INSERT INTO variables (id, key, value) VALUES (${literal(`feed-${key}`)}, ${literal(`feed-${key}`)}, ${literal(value)});`,
		);
	const schedule = async (workflowId: string) =>
		(await (
			await instance.worker.fetch(`${instance.origin}/__test/schedule/${workflowId}`)
		).json()) as Schedule;
	const occurrences = async (workflowId: string) =>
		(await (
			await instance.worker.fetch(`${instance.origin}/__test/scheduler/${workflowId}/occurrences`)
		).json()) as string[];
	const fire = async (workflowId: string) =>
		await instance.worker.fetch(`${instance.origin}/__test/scheduler/${workflowId}/fire`, {
			method: 'POST',
		});
	const savedData = async (executionId: unknown) =>
		(await (
			await instance.worker.fetch(`${instance.origin}/__test/data/${executionId}`)
		).json()) as {
			resultData: { error?: { message: string }; runData: Record<string, unknown> };
		};

	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('records a failed poll, runs the error workflow and still runs the other polls', async () => {
		const handler: IWorkflowBase = workflow('poll-handler', [
			node('Error', 'errorTrigger', {}),
			setNode('={{ $json.trigger.error.message }}'),
		]);
		handler.settings = { executionOrder: 'v1', callerPolicy: 'any' };
		seed(instance, handler);
		execDb(
			instance,
			`INSERT INTO workflow_history (versionId, workflowId, authors, nodes, connections, createdAt, updatedAt) VALUES ('poll-handler-published', 'poll-handler', 'test', ${literal(JSON.stringify(handler.nodes))}, ${literal(JSON.stringify(handler.connections))}, datetime('now'), datetime('now')); UPDATE workflow_entity SET activeVersionId = 'poll-handler-published' WHERE id = 'poll-handler';`,
		);
		setFeed('broken', '2000-01-01');
		setFeed('working', '2000-01-01');
		const polling = workflow(
			'poll-failing',
			[feed('Broken', 'broken'), feed('Working', 'working'), setNode()],
			{
				Broken: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
				Working: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
			},
		);
		polling.settings = { executionOrder: 'v1', timezone: 'UTC', errorWorkflow: 'poll-handler' };
		await activate(instance, polling);

		setFeed('broken', 'fail');
		setFeed('working', '2099-01-01');
		const firedAt = Date.now();
		await fire('poll-failing');
		await eventually(() => {
			const rows = executions(instance, 'poll-failing');
			expect(rows.map((row) => row.status).sort()).toEqual(['error', 'success']);
		});
		const failed = executions(instance, 'poll-failing').find((row) => row.status === 'error');
		expect(failed).toMatchObject({ mode: 'trigger', stoppedAt: expect.any(String) });
		const data = await savedData(failed?.id);
		expect(data.resultData.error?.message).toBeTruthy();
		expect(data.resultData.runData).toHaveProperty('Broken');

		await eventually(() => expect(executions(instance, 'poll-handler')[0]?.status).toBe('success'));
		const handled = await savedData(executions(instance, 'poll-handler')[0].id);
		expect(JSON.stringify(handled)).toContain(data.resultData.error?.message ?? 'missing');

		// The failure is a handled occurrence. Both schedules move to the next minute, with no 10 second retry.
		const after = await schedule('poll-failing');
		for (const row of after.schedules) expect(row.nextFire).toBeGreaterThan(firedAt);
		expect(after.alarm).toBe(Math.min(...after.schedules.map((row) => row.nextFire)));
		expect(await occurrences('poll-failing')).toEqual([]);
		await instance.worker.fetch(`${instance.origin}/__test/deactivate/poll-failing`, {
			method: 'POST',
		});
	});

	it('drops the output of a poll that a reconfiguration replaced', async () => {
		setFeed('reconfigured', '2000-01-01');
		const data = workflow('poll-reconfigured', [feed('Rss', 'reconfigured'), setNode()]);
		await activate(instance, data);
		// The next poll takes 3 seconds and finds a new item.
		setFeed('reconfigured', 'slow:2099-01-01');
		await fire('poll-reconfigured');
		await new Promise((resolve) => setTimeout(resolve, 1000));
		setFeed('reconfigured', '2099-01-01');
		const reactivated = await instance.worker.fetch(
			`${instance.origin}/__test/activate/poll-reconfigured`,
			{ method: 'POST' },
		);
		expect(reactivated.status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 3500));
		expect(await occurrences('poll-reconfigured')).toEqual([]);
		expect(executions(instance, 'poll-reconfigured')).toEqual([]);
		const after = await schedule('poll-reconfigured');
		expect(after.schedules).toHaveLength(1);
		expect(after.schedules[0].nextFire).toBeGreaterThan(Date.now());
		await instance.worker.fetch(`${instance.origin}/__test/deactivate/poll-reconfigured`, {
			method: 'POST',
		});
	});
});
