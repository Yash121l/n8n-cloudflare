import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstance } from '../api/harness';
import type { Instance } from '../api/harness';
import { activate, eventually, executions, node, setNode, workflow } from '../webhooks/fixtures';

interface Schedule {
	alarm: number | null;
	schedules: Array<{ nextFire: number }>;
}

describe('missed schedule fires', () => {
	let instance: Instance;
	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('fires a late occurrence once and computes the next fire from now, like stock cron', async () => {
		await activate(
			instance,
			workflow('hourly', [
				node(
					'Schedule',
					'scheduleTrigger',
					{ rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } },
					1.3,
				),
				setNode(),
			]),
		);
		const hour = 60 * 60 * 1000;
		// Five hourly fires were missed, and the alarm arrives twice.
		const missed = await instance.worker.fetch(
			`${instance.origin}/__test/scheduler/hourly/miss-fires`,
			{
				method: 'POST',
				body: JSON.stringify({ ms: 5 * hour }),
			},
		);
		expect(missed.status).toBe(200);
		const now = Date.now();
		await eventually(() =>
			expect(executions(instance, 'hourly')[0]).toMatchObject({
				mode: 'trigger',
				status: 'success',
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(executions(instance, 'hourly')).toHaveLength(1);

		const schedule = (await (
			await instance.worker.fetch(`${instance.origin}/__test/schedule/hourly`)
		).json()) as Schedule;
		const [{ nextFire }] = schedule.schedules;
		expect(nextFire).toBeGreaterThan(now);
		expect(nextFire).toBeLessThanOrEqual(now + hour);
		expect(schedule.alarm).toBe(nextFire);
		const occurrences = await (
			await instance.worker.fetch(`${instance.origin}/__test/scheduler/hourly/occurrences`)
		).json();
		expect(occurrences).toEqual([]);
	});
});
