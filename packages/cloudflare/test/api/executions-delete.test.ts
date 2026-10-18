import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, dataOf, recordOf, startInstance } from './harness';
import type { Session } from './harness';
import { execDb, literal, queryDb } from './sql';

const WORKFLOW_ID = 'wf0000000000delete';
const NOW = '2026-10-01T10:00:00.000Z';

const seed = (instance: Instance, id: number, status: string, startedAt: string) =>
	execDb(
		instance,
		`INSERT INTO execution_entity (id, workflowId, finished, mode, status, createdAt, startedAt, workflowVersionId)
		VALUES (${id}, ${literal(WORKFLOW_ID)}, 0, 'manual', ${literal(status)}, ${literal(startedAt)}, ${literal(startedAt)}, 'v1')`,
	);

describe('executions delete', () => {
	let instance: Instance;
	let owner: Session;

	const remaining = () =>
		queryDb(instance, 'SELECT id FROM execution_entity ORDER BY id').map((r) => r.id);

	beforeAll(async () => {
		instance = await startInstance();
		owner = await instance.ownerSession();
		const personal = recordOf(dataOf(await owner.get('/rest/projects/personal')));
		execDb(
			instance,
			`INSERT INTO workflow_entity (id, name, nodes, connections, versionId, createdAt, updatedAt)
			VALUES (${literal(WORKFLOW_ID)}, 'Seeded', '[]', '{}', 'v1', ${literal(NOW)}, ${literal(NOW)});
			INSERT INTO shared_workflow (workflowId, projectId, role, createdAt, updatedAt)
			VALUES (${literal(WORKFLOW_ID)}, ${literal(String(personal.id))}, 'workflow:owner', ${literal(NOW)}, ${literal(NOW)})`,
		);
		seed(instance, 1, 'success', '2026-10-01T10:00:01.000Z');
		seed(instance, 2, 'error', '2026-10-01T10:00:02.000Z');
		seed(instance, 3, 'running', '2026-10-01T10:00:03.000Z');
		seed(instance, 4, 'waiting', '2026-10-01T10:00:04.000Z');
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('refuses a request with no ids and no date', async () => {
		for (const body of [{}, { filters: {} }, { filters: { workflowId: WORKFLOW_ID } }]) {
			const res = await owner.post('/rest/executions/delete', body);
			expect(res.status, JSON.stringify(body)).toBe(400);
		}
		expect(remaining()).toEqual([1, 2, 3, 4]);
	});

	it('keeps a running execution when it is named by id or caught by a date', async () => {
		expect((await owner.post('/rest/executions/delete', { ids: ['3'] })).status).toBe(200);
		expect(
			(await owner.post('/rest/executions/delete', { deleteBefore: '2026-10-01T10:00:03.000Z' }))
				.status,
		).toBe(200);
		expect(remaining()).toEqual([3, 4]);
	});

	it('uses the filters to narrow a delete by date', async () => {
		const miss = await owner.post('/rest/executions/delete', {
			deleteBefore: '2026-10-02T00:00:00.000Z',
			filters: { workflowId: 'other' },
		});
		expect(miss.status).toBe(200);
		expect(remaining()).toEqual([3, 4]);

		await owner.post('/rest/executions/delete', {
			deleteBefore: '2026-10-02T00:00:00.000Z',
			filters: { workflowId: WORKFLOW_ID },
		});
		expect(remaining()).toEqual([3]);
	});
});
