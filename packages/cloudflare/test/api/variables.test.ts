import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, arrayOf, dataOf, recordOf, startInstance } from './harness';
import type { Session } from './harness';

describe('variables', () => {
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
		expect((await instance.session().get('/rest/variables')).status).toBe(401);
	});

	it('creates, reads, updates, lists and deletes a variable', async () => {
		expect(dataOf(await session.get('/rest/variables'))).toEqual([]);

		const created = await session.post('/rest/variables', {
			key: 'API_URL',
			value: 'https://example.com',
		});
		expect(created.status).toBe(200);
		const variable = recordOf(dataOf(created));
		expect(variable).toMatchObject({
			key: 'API_URL',
			value: 'https://example.com',
			type: 'string',
			project: null,
		});
		const id = String(variable.id);

		expect(recordOf(dataOf(await session.get(`/rest/variables/${id}`))).key).toBe('API_URL');

		const updated = await session.patch(`/rest/variables/${id}`, { key: 'API_BASE', value: 'x' });
		expect(recordOf(dataOf(updated))).toMatchObject({ id, key: 'API_BASE', value: 'x' });

		expect(arrayOf(dataOf(await session.get('/rest/variables')))).toHaveLength(1);
		expect(arrayOf(dataOf(await session.get('/rest/variables?state=empty')))).toHaveLength(0);

		expect(dataOf(await session.delete(`/rest/variables/${id}`))).toBe(true);
		expect((await session.get(`/rest/variables/${id}`)).status).toBe(404);
	});

	it('rejects invalid and duplicate keys', async () => {
		expect((await session.post('/rest/variables', { key: '1bad', value: 'x' })).status).toBe(400);
		expect((await session.post('/rest/variables', { key: 'DUP', value: 'a' })).status).toBe(200);
		const duplicate = await session.post('/rest/variables', { key: 'DUP', value: 'b' });
		expect(duplicate.status).toBe(400);
		expect(recordOf(duplicate.body).message).toContain('already exists');
	});

	it('scopes a variable to a project', async () => {
		const project = recordOf(dataOf(await session.get('/rest/projects/personal')));
		const created = await session.post('/rest/variables', {
			key: 'DUP',
			value: 'scoped',
			projectId: String(project.id),
		});
		expect(created.status).toBe(200);
		expect(recordOf(recordOf(dataOf(created)).project).id).toBe(project.id);
		const onlyProject = arrayOf(
			dataOf(await session.get(`/rest/variables?projectId=${String(project.id)}`)),
		);
		expect(onlyProject).toHaveLength(1);
	});
});
