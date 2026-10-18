import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstance } from '../api/harness';
import type { Instance } from '../api/harness';
import { execDb, queryDb } from '../api/sql';
import {
	activate,
	eventually,
	executions,
	node,
	seed,
	setNode,
	webhookNode,
	workflow,
} from '../webhooks/fixtures';

describe('built worker activation and alarms', () => {
	let instance: Instance;
	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('stores a Schedule Trigger alarm and executes from a real alarm', async () => {
		await activate(
			instance,
			workflow('scheduled', [
				node(
					'Schedule',
					'scheduleTrigger',
					{ rule: { interval: [{ field: 'seconds', secondsInterval: 2 }] } },
					1.3,
				),
				setNode(),
			]),
		);
		const schedule = (await (
			await instance.worker.fetch(`${instance.origin}/__test/schedule/scheduled`)
		).json()) as { alarm: number; schedules: unknown[] };
		expect(schedule.alarm).toBeGreaterThan(0);
		expect(schedule.schedules).toHaveLength(1);
		await eventually(() =>
			expect(executions(instance, 'scheduled')[0]).toMatchObject({
				mode: 'trigger',
				status: 'success',
			}),
		);
		await instance.worker.fetch(`${instance.origin}/__test/deactivate/scheduled`, {
			method: 'POST',
		});
		const cleared = await (
			await instance.worker.fetch(`${instance.origin}/__test/schedule/scheduled`)
		).json();
		expect(cleared).toEqual({ alarm: null, schedules: [] });
	});

	it('rejects path conflicts without removing the first workflow registration', async () => {
		await activate(instance, workflow('first', [webhookNode('conflict'), setNode()]));
		seed(instance, workflow('second', [webhookNode('conflict'), setNode()]));
		const response = await instance.worker.fetch(`${instance.origin}/__test/activate/second`, {
			method: 'POST',
		});
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			message: expect.stringContaining('already used'),
		});
		expect(
			queryDb(instance, "SELECT workflowId FROM webhook_entity WHERE webhookPath = 'conflict'"),
		).toEqual([{ workflowId: 'first' }]);
	});

	it('fails the activation of a persistent connection trigger that cannot connect, and keeps no connection', async () => {
		seed(
			instance,
			workflow('persistent', [
				node('Mailbox', 'emailReadImap', { mailbox: 'INBOX', options: {} }),
				setNode(),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/__test/activate/persistent`, {
			method: 'POST',
		});
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ message: expect.any(String) });
		const state = await (
			await instance.worker.fetch(`${instance.origin}/__test/connection/persistent/Mailbox`)
		).json();
		expect(state).toMatchObject({ configured: false, connected: false, alarm: null });
	});

	it('removes production webhooks on deactivation', async () => {
		await activate(instance, workflow('removed', [webhookNode('removed'), setNode()]));
		expect(
			(
				await instance.worker.fetch(`${instance.origin}/__test/deactivate/removed`, {
					method: 'POST',
				})
			).status,
		).toBe(200);
		expect((await instance.worker.fetch(`${instance.origin}/webhook/removed`)).status).toBe(404);
	});

	it('seeds a poll cursor and persists it after a real polling alarm', async () => {
		execDb(
			instance,
			"INSERT INTO variables (id, key, value) VALUES ('rss-date', 'rss-date', '2000-01-01T00:00:00.000Z')",
		);
		await activate(
			instance,
			workflow('polling', [
				node('Rss', 'rssFeedReadTrigger', {
					feedUrl: `${instance.origin}/__test/rss`,
					pollTimes: { item: [{ mode: 'everyMinute' }] },
				}),
				setNode(),
			]),
		);
		const before = queryDb(
			instance,
			"SELECT staticData FROM workflow_entity WHERE id = 'polling'",
		)[0];
		expect(JSON.parse(String(before.staticData))).toMatchObject({
			'node:Rss': { lastItemDate: '2000-01-01T00:00:00.000Z' },
		});
		expect(executions(instance, 'polling')).toHaveLength(0);
		execDb(
			instance,
			"UPDATE variables SET value = '2099-01-01T00:00:00.000Z' WHERE key = 'rss-date'",
		);
		await eventually(async () => {
			const rows = (await (
				await instance.worker.fetch(`${instance.origin}/__test/executions/polling`)
			).json()) as Array<Record<string, unknown>>;
			expect(rows[0]).toMatchObject({ mode: 'trigger', status: 'success' });
		}, 75_000);
		const after = queryDb(
			instance,
			"SELECT staticData FROM workflow_entity WHERE id = 'polling'",
		)[0];
		expect(JSON.parse(String(after.staticData))).toMatchObject({
			'node:Rss': { lastItemDate: '2099-01-01T00:00:00.000Z' },
		});
		await instance.worker.fetch(`${instance.origin}/__test/deactivate/polling`, { method: 'POST' });
	}, 85_000);
});
