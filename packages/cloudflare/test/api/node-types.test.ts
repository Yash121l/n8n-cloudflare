import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, arrayOf, dataOf, recordOf, startInstance } from './harness';
import type { Session } from './harness';

describe('node types and dynamic parameters', () => {
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
		expect((await instance.session().post('/rest/node-types', { nodeInfos: [] })).status).toBe(401);
	});

	it('returns descriptions for requested nodes', async () => {
		const res = await session.post('/rest/node-types', {
			nodeInfos: [{ name: 'n8n-nodes-base.noOp', version: 1 }],
		});
		expect(res.status).toBe(200);
		const [description] = arrayOf(dataOf(res));
		expect(String(recordOf(description).name)).toMatch(/noOp$/);
	});

	it('returns descriptions by identifier and skips malformed ones', async () => {
		const res = await session.post('/rest/node-types/by-identifier', {
			identifiers: ['n8n-nodes-base.noOp@1'],
		});
		expect(arrayOf(dataOf(res))).toHaveLength(1);
	});

	it('answers malformed node requests with a JSON 400', async () => {
		const res = await session.post('/rest/node-types', { nodeInfos: [{ name: 1 }] });
		expect(res.status).toBe(400);
		expect(recordOf(res.body).code).toBe(400);
		expect((await session.post('/rest/node-types/by-identifier', { identifiers: [] })).status).toBe(
			400,
		);
	});

	it('validates dynamic parameter requests', async () => {
		for (const route of [
			'options',
			'resource-locator-results',
			'resource-mapper-fields',
			'local-resource-mapper-fields',
			'action-result',
		]) {
			const res = await session.post(`/rest/dynamic-node-parameters/${route}`, { path: 'x' });
			expect(res.status, route).toBe(400);
		}
	});

	it('returns no options when no method or load options are given', async () => {
		const res = await session.post('/rest/dynamic-node-parameters/options', {
			path: 'parameters.x',
			nodeTypeAndVersion: { name: 'n8n-nodes-base.noOp', version: 1 },
			currentNodeParameters: {},
		});
		expect(dataOf(res)).toEqual([]);
	});

	it('returns a JSON error for an unknown node', async () => {
		const res = await session.post('/rest/dynamic-node-parameters/resource-locator-results', {
			path: 'parameters.x',
			methodName: 'getThings',
			nodeTypeAndVersion: { name: 'n8n-nodes-base.doesNotExist', version: 1 },
			currentNodeParameters: {},
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(recordOf(res.body).message).toEqual(expect.any(String));
	});
});
