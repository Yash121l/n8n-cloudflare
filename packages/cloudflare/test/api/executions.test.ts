import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, arrayOf, dataOf, recordOf, startInstance } from './harness';
import type { Session } from './harness';
import { execDb, literal, queryDb } from './sql';

const WORKFLOW_ID = 'wf0000000000test';

function seedExecution(instance: Instance, row: { id: number; status: string; startedAt: string }) {
	const finished = row.status === 'success' ? 1 : 0;
	const stopped = ['success', 'error'].includes(row.status) ? literal(row.startedAt) : 'NULL';
	execDb(
		instance,
		`INSERT INTO execution_entity (id, workflowId, finished, mode, status, createdAt, startedAt, stoppedAt, workflowVersionId)
		VALUES (${row.id}, ${literal(WORKFLOW_ID)}, ${finished}, 'manual', ${literal(row.status)},
			${literal(row.startedAt)}, ${literal(row.startedAt)}, ${stopped}, 'v1')`,
	);
}

const filterUrl = (value: unknown) =>
	`/rest/executions?filter=${encodeURIComponent(JSON.stringify(value))}`;
const idsOf = (page: Record<string, unknown>) => arrayOf(page.results).map((r) => recordOf(r).id);

describe('executions', () => {
	let instance: Instance;
	let session: Session;

	beforeAll(async () => {
		instance = await startInstance();
		session = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('requires a session', async () => {
		expect((await instance.session().get('/rest/executions')).status).toBe(401);
	});

	it('lists no executions on a new instance', async () => {
		const res = await session.get('/rest/executions?limit=10');
		expect(res.status).toBe(200);
		expect(dataOf(res)).toEqual({
			results: [],
			nextCursor: null,
			count: 0,
			estimated: false,
			concurrentExecutionsCount: -1,
		});
	});

	it('validates list parameters and ids', async () => {
		expect((await session.get('/rest/executions?limit=0')).status).toBe(400);
		expect((await session.get('/rest/executions?limit=101')).status).toBe(400);
		expect((await session.get('/rest/executions?cursor=!!')).status).toBe(400);
		expect((await session.get('/rest/executions?firstId=1')).status).toBe(400);
		expect((await session.get(filterUrl({ status: 'error' }))).status).toBe(400);
		expect((await session.get('/rest/executions/abc')).status).toBe(400);
	});

	it('returns an empty body for an unknown execution', async () => {
		const res = await session.get('/rest/executions/999');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({});
	});

	describe('with stored executions', () => {
		beforeAll(async () => {
			const personal = recordOf(dataOf(await session.get('/rest/projects/personal')));
			const now = '2026-10-01T10:00:00.000Z';
			execDb(
				instance,
				`INSERT INTO workflow_entity (id, name, nodes, connections, versionId, createdAt, updatedAt)
				VALUES (${literal(WORKFLOW_ID)}, 'Seeded', '[]', '{}', 'v1', ${literal(now)}, ${literal(now)});
				INSERT INTO shared_workflow (workflowId, projectId, role, createdAt, updatedAt)
				VALUES (${literal(WORKFLOW_ID)}, ${literal(String(personal.id))}, 'workflow:owner', ${literal(now)}, ${literal(now)})`,
			);
			seedExecution(instance, { id: 1, status: 'success', startedAt: '2026-10-01T10:00:01.000Z' });
			seedExecution(instance, { id: 2, status: 'error', startedAt: '2026-10-01T10:00:02.000Z' });
			seedExecution(instance, { id: 3, status: 'success', startedAt: '2026-10-01T10:00:03.000Z' });
			seedExecution(instance, { id: 4, status: 'running', startedAt: '2026-10-01T10:00:04.000Z' });
		});

		it('puts running executions first and counts completed ones', async () => {
			const page = recordOf(dataOf(await session.get('/rest/executions?limit=10')));
			expect(page.count).toBe(3);
			expect(idsOf(page)).toEqual(['4', '3', '2', '1']);
			const [running] = arrayOf(page.results).map(recordOf);
			expect(running).toMatchObject({
				status: 'running',
				mode: 'manual',
				workflowId: WORKFLOW_ID,
				workflowName: 'Seeded',
				finished: false,
			});
			expect(arrayOf(running.scopes)).toEqual(
				expect.arrayContaining(['workflow:execute', 'execution:read']),
			);
		});

		it('pages with cursors', async () => {
			const first = recordOf(dataOf(await session.get('/rest/executions?limit=2')));
			expect(idsOf(first)).toEqual(['4', '3', '2']);
			expect(typeof first.nextCursor).toBe('string');

			const second = recordOf(
				dataOf(await session.get(`/rest/executions?limit=2&cursor=${String(first.nextCursor)}`)),
			);
			expect(idsOf(second)).toEqual(['1']);
			expect(second.nextCursor).toBeNull();
		});

		it('filters by status, workflow and start time', async () => {
			const errors = recordOf(dataOf(await session.get(filterUrl({ status: ['error'] }))));
			expect(idsOf(errors)).toEqual(['2']);
			expect(errors.count).toBe(1);

			const other = recordOf(dataOf(await session.get(filterUrl({ workflowId: 'other' }))));
			expect(other.results).toEqual([]);

			const since = recordOf(
				dataOf(await session.get(filterUrl({ startedAfter: '2026-10-01T10:00:03.000Z' }))),
			);
			expect(idsOf(since)).toEqual(['4', '3']);
		});

		it('returns a running execution with its workflow and empty run data', async () => {
			const res = recordOf(dataOf(await session.get('/rest/executions/4')));
			expect(res).toMatchObject({
				id: '4',
				status: 'running',
				workflowId: WORKFLOW_ID,
				finished: false,
			});
			expect(recordOf(res.workflowData)).toMatchObject({ id: WORKFLOW_ID, name: 'Seeded' });
			expect(typeof res.data).toBe('string');
		});

		it('reports finished executions whose data was removed as not found', async () => {
			expect((await session.get('/rest/executions/3')).status).toBe(404);
		});

		it('lists the workflow versions that executed', async () => {
			expect(dataOf(await session.get(`/rest/executions/versions/${WORKFLOW_ID}`))).toEqual([]);
		});

		it('stops a running execution', async () => {
			const res = recordOf(dataOf(await session.post('/rest/executions/4/stop')));
			expect(res).toMatchObject({ mode: 'manual', finished: false, status: 'canceled' });
			expect((await session.post('/rest/executions/3/stop')).status).toBe(400);
			expect((await session.post('/rest/executions/999/stop')).status).toBe(404);
		});

		it('stops many executions and reports how many', async () => {
			seedExecution(instance, { id: 5, status: 'running', startedAt: '2026-10-01T10:00:05.000Z' });
			const res = await session.post('/rest/executions/stopMany', {
				filter: { workflowId: WORKFLOW_ID },
			});
			expect(dataOf(res)).toEqual({ stopped: 1 });
		});

		it('deletes executions by id and by date', async () => {
			expect((await session.post('/rest/executions/delete', {})).status).toBe(400);
			expect((await session.post('/rest/executions/delete', { ids: ['1'] })).status).toBe(200);
			expect(queryDb(instance, 'SELECT id FROM execution_entity WHERE id = 1')).toEqual([]);

			const res = await session.post('/rest/executions/delete', {
				deleteBefore: '2026-10-01T10:00:03.500Z',
			});
			expect(res.status).toBe(200);
			const left = queryDb(instance, 'SELECT id FROM execution_entity ORDER BY id').map(
				(r) => r.id,
			);
			expect(left).toEqual([4, 5]);
		});
	});
});
