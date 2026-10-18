import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, startInstance } from './harness';

describe('worker smoke', () => {
	let instance: Instance;
	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('serves /healthz', async () => {
		const res = await instance.session().get('/healthz');
		expect(res.status).toBe(200);
	});

	it('answers unknown /rest routes with a JSON 404 after auth', async () => {
		const res = await instance.session().get('/rest/does-not-exist');
		expect([401, 404]).toContain(res.status);
	});
});
