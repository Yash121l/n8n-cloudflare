import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, Session, arrayOf, dataOf, recordOf, startInstance } from './harness';
import { queryDb } from './sql';

const manual = {
	name: 'Manual',
	type: 'n8n-nodes-base.manualTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};
const failing = {
	name: 'Fail',
	type: 'n8n-nodes-base.stopAndError',
	typeVersion: 1,
	position: [200, 0],
	parameters: { errorMessage: 'boom' },
};
const fixed = {
	name: 'Fail',
	type: 'n8n-nodes-base.noOp',
	typeVersion: 1,
	position: [200, 0],
	parameters: {},
};
const connections = { Manual: { main: [[{ node: 'Fail', type: 'main', index: 0 }]] } };

async function waitForEnd(session: Session, id: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 90_000;
	for (;;) {
		const res = await session.get(`/rest/executions/${id}`);
		const execution = res.status === 200 ? recordOf(dataOf(res)) : undefined;
		if (execution && !['new', 'running', 'waiting'].includes(String(execution.status)))
			return execution;
		if (Date.now() > deadline) throw new Error('execution timed out');
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

describe('execution retry and annotations', () => {
	let instance: Instance;
	let owner: Session;
	let workflow: Record<string, unknown>;
	let failedId: string;

	const filterUrl = (filter: object) =>
		`/rest/executions?filter=${encodeURIComponent(JSON.stringify(filter))}`;

	beforeAll(async () => {
		instance = await startInstance();
		owner = await instance.ownerSession();
		const created = await owner.post('/rest/workflows', {
			name: 'Retry me',
			nodes: [manual, failing],
			connections,
			settings: { executionOrder: 'v1' },
		});
		expect(created.status, JSON.stringify(created.body)).toBe(200);
		workflow = recordOf(dataOf(created));
		const run = await owner.post(`/rest/workflows/${String(workflow.id)}/run`, {
			workflowData: workflow,
			triggerToStartFrom: { name: 'Manual' },
		});
		expect(run.status, JSON.stringify(run.body)).toBe(200);
		failedId = String(recordOf(dataOf(run)).executionId);
		expect((await waitForEnd(owner, failedId)).status).toBe('error');
	}, 180_000);

	afterAll(async () => {
		await instance?.dispose();
	});

	describe('retry', () => {
		it('retries the stored workflow as a new execution with retryOf set', async () => {
			const res = await owner.post(`/rest/executions/${failedId}/retry`);
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			const retried = recordOf(dataOf(res));
			expect(retried).toMatchObject({
				mode: 'retry',
				retryOf: failedId,
				status: 'error',
				finished: false,
			});
			expect(retried.id).not.toBe(failedId);

			const stored = recordOf(dataOf(await owner.get(`/rest/executions/${String(retried.id)}`)));
			expect(stored).toMatchObject({ mode: 'retry', retryOf: failedId, status: 'error' });
			const original = recordOf(dataOf(await owner.get(`/rest/executions/${failedId}`)));
			expect(original.retrySuccessId).toBeNull();
		}, 120_000);

		it('retries with the current saved workflow and sets retrySuccessId on success', async () => {
			const patched = await owner.patch(`/rest/workflows/${String(workflow.id)}`, {
				nodes: [manual, fixed],
				connections,
				versionId: workflow.versionId,
			});
			expect(patched.status, JSON.stringify(patched.body)).toBe(200);

			const res = await owner.post(`/rest/executions/${failedId}/retry`, { loadWorkflow: true });
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			const retried = recordOf(dataOf(res));
			expect(retried).toMatchObject({
				mode: 'retry',
				retryOf: failedId,
				status: 'success',
				finished: true,
			});
			const nodes = arrayOf(recordOf(retried.workflowData).nodes).map((n) => recordOf(n).type);
			expect(nodes).toContain('n8n-nodes-base.noOp');

			const original = recordOf(dataOf(await owner.get(`/rest/executions/${failedId}`)));
			expect(original.retrySuccessId).toBe(String(retried.id));
			expect(
				queryDb(instance, `SELECT retrySuccessId FROM execution_entity WHERE id = ${failedId}`),
			).toEqual([{ retrySuccessId: String(retried.id) }]);

			const list = recordOf(dataOf(await owner.get(filterUrl({ retryOf: failedId }))));
			expect(arrayOf(list.results).length).toBe(2);
		}, 120_000);

		it('refuses executions that cannot be retried', async () => {
			const list = recordOf(dataOf(await owner.get(filterUrl({ status: ['success'] }))));
			const successId = String(recordOf(arrayOf(list.results)[0]).id);
			expect((await owner.post(`/rest/executions/${successId}/retry`)).status).toBe(409);
			expect((await owner.post('/rest/executions/99999/retry')).status).toBe(404);
			expect((await owner.post('/rest/executions/abc/retry')).status).toBe(400);
			expect((await instance.session().post(`/rest/executions/${failedId}/retry`)).status).toBe(
				401,
			);
		});
	});

	describe('annotations', () => {
		const tagIds: string[] = [];

		it('manages annotation tags', async () => {
			expect(dataOf(await owner.get('/rest/annotation-tags'))).toEqual([]);
			for (const name of ['alpha', 'beta']) {
				const tag = recordOf(dataOf(await owner.post('/rest/annotation-tags', { name })));
				expect(tag).toMatchObject({ name });
				tagIds.push(String(tag.id));
			}
			expect((await owner.post('/rest/annotation-tags', { name: 'alpha' })).status).toBe(400);
			expect((await owner.post('/rest/annotation-tags', { name: 'x'.repeat(25) })).status).toBe(
				400,
			);
			const renamed = recordOf(
				dataOf(await owner.patch(`/rest/annotation-tags/${tagIds[1]}`, { name: 'gamma' })),
			);
			expect(renamed).toMatchObject({ id: tagIds[1], name: 'gamma' });
			expect((await owner.patch('/rest/annotation-tags/missing', { name: 'new' })).status).toBe(
				404,
			);
		});

		it('has no annotation until one is set', async () => {
			const detail = recordOf(dataOf(await owner.get(`/rest/executions/${failedId}`)));
			expect(detail.annotation).toBeUndefined();
			const list = recordOf(dataOf(await owner.get('/rest/executions')));
			const row = arrayOf(list.results)
				.map(recordOf)
				.find((r) => r.id === failedId);
			expect(row?.annotation).toEqual({ vote: null, tags: [] });
		});

		it('stores a vote and tags and returns them from get and list', async () => {
			const res = await owner.patch(`/rest/executions/${failedId}`, { vote: 'up', tags: tagIds });
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			const annotation = recordOf(recordOf(dataOf(res)).annotation);
			expect(annotation).toMatchObject({ vote: 'up' });
			expect(
				arrayOf(annotation.tags)
					.map((t) => recordOf(t).name)
					.sort(),
			).toEqual(['alpha', 'gamma']);

			const detail = recordOf(dataOf(await owner.get(`/rest/executions/${failedId}`)));
			expect(recordOf(detail.annotation).vote).toBe('up');
			const list = recordOf(dataOf(await owner.get('/rest/executions')));
			const row = arrayOf(list.results)
				.map(recordOf)
				.find((r) => r.id === failedId);
			expect(recordOf(row?.annotation).vote).toBe('up');
			expect(arrayOf(recordOf(row?.annotation).tags)).toHaveLength(2);
			expect(
				queryDb(instance, `SELECT vote FROM execution_annotations WHERE executionId = ${failedId}`),
			).toEqual([{ vote: 'up' }]);
		});

		it('keeps the vote when only tags change and the tags when only the vote changes', async () => {
			await owner.patch(`/rest/executions/${failedId}`, { tags: [tagIds[0]] });
			let annotation = recordOf(
				recordOf(dataOf(await owner.get(`/rest/executions/${failedId}`))).annotation,
			);
			expect(annotation.vote).toBe('up');
			expect(arrayOf(annotation.tags).map((t) => recordOf(t).name)).toEqual(['alpha']);

			await owner.patch(`/rest/executions/${failedId}`, { vote: 'down' });
			annotation = recordOf(
				recordOf(dataOf(await owner.get(`/rest/executions/${failedId}`))).annotation,
			);
			expect(annotation.vote).toBe('down');
			expect(arrayOf(annotation.tags)).toHaveLength(1);

			await owner.patch(`/rest/executions/${failedId}`, { vote: null, tags: [] });
			annotation = recordOf(
				recordOf(dataOf(await owner.get(`/rest/executions/${failedId}`))).annotation,
			);
			expect(annotation.vote).toBeNull();
			expect(annotation.tags).toEqual([]);
		});

		it('filters the list by vote and annotation tag and counts tag usage', async () => {
			await owner.patch(`/rest/executions/${failedId}`, { vote: 'up', tags: [tagIds[1]] });
			const ids = async (filter: object) =>
				arrayOf(recordOf(dataOf(await owner.get(filterUrl(filter)))).results).map(
					(r) => recordOf(r).id,
				);
			expect(await ids({ vote: 'up' })).toEqual([failedId]);
			expect(await ids({ vote: 'down' })).toEqual([]);
			expect(await ids({ annotationTags: [tagIds[1]] })).toEqual([failedId]);
			expect(await ids({ annotationTags: [tagIds[0]] })).toEqual([]);
			const counts = arrayOf(
				dataOf(await owner.get('/rest/annotation-tags?withUsageCount=true')),
			).map(recordOf);
			expect(counts.find((t) => t.id === tagIds[1])?.usageCount).toBe(1);
		});

		it('validates the payload', async () => {
			expect((await owner.patch(`/rest/executions/${failedId}`, {})).status).toBe(400);
			expect((await owner.patch(`/rest/executions/${failedId}`, { vote: 'sideways' })).status).toBe(
				400,
			);
			expect((await owner.patch(`/rest/executions/${failedId}`, { tags: 'x' })).status).toBe(400);
			expect((await owner.patch(`/rest/executions/${failedId}`, { tags: ['nope'] })).status).toBe(
				404,
			);
			expect((await owner.patch('/rest/executions/99999', { vote: 'up' })).status).toBe(404);
			expect((await owner.patch('/rest/executions/abc', { vote: 'up' })).status).toBe(400);
			expect(
				(await instance.session().patch(`/rest/executions/${failedId}`, { vote: 'up' })).status,
			).toBe(401);
		});

		it('removes mappings when a tag or the execution is deleted', async () => {
			expect(dataOf(await owner.delete(`/rest/annotation-tags/${tagIds[1]}`))).toBe(true);
			const annotation = recordOf(
				recordOf(dataOf(await owner.get(`/rest/executions/${failedId}`))).annotation,
			);
			expect(annotation.tags).toEqual([]);
			expect((await owner.post('/rest/executions/delete', { ids: [failedId] })).status).toBe(200);
			expect(queryDb(instance, 'SELECT id FROM execution_annotations')).toEqual([]);
		});
	});
});
