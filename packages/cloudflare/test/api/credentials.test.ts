import { createDecipheriv, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ENCRYPTION_KEY, Instance, arrayOf, dataOf, recordOf, startInstance } from './harness';
import type { Session } from './harness';
import { queryDb } from './sql';

const BLANK = '__n8n_BLANK_VALUE_e5362baf-c777-4d57-a609-6eaf1f9e87f6';

/** Stock n8n credential ciphertext: "Salted__" + salt + AES-256-CBC, key from EVP_BytesToKey (MD5). */
function decryptStored(ciphertext: string): Record<string, unknown> {
	const raw = Buffer.from(ciphertext, 'base64');
	expect(raw.subarray(0, 8).toString('latin1')).toBe('Salted__');
	const password = Buffer.concat([Buffer.from(ENCRYPTION_KEY, 'binary'), raw.subarray(8, 16)]);
	const h1 = createHash('md5').update(password).digest();
	const h2 = createHash('md5')
		.update(Buffer.concat([h1, password]))
		.digest();
	const iv = createHash('md5')
		.update(Buffer.concat([h2, password]))
		.digest();
	const decipher = createDecipheriv('aes-256-cbc', Buffer.concat([h1, h2]), iv);
	const plain = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString(
		'utf8',
	);
	return recordOf(JSON.parse(plain));
}

const storedData = (instance: Instance, id: string): string => {
	const rows = queryDb(instance, `SELECT data FROM credentials_entity WHERE id = '${id}'`);
	const data = rows[0]?.data;
	if (typeof data !== 'string') throw new Error('credential row not found');
	return data;
};

describe('credentials', () => {
	let instance: Instance;
	let session: Session;
	let personalProjectId: string;

	beforeAll(async () => {
		instance = await startInstance();
		session = await instance.ownerSession();
		personalProjectId = String(recordOf(dataOf(await session.get('/rest/projects/personal'))).id);
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('rejects requests without a session', async () => {
		const res = await instance.session().get('/rest/credentials');
		expect(res.status).toBe(401);
	});

	it('suggests a unique name', async () => {
		const res = await session.get('/rest/credentials/new');
		expect(dataOf(res)).toEqual({ name: 'My credentials' });
		const named = await session.get('/rest/credentials/new?name=GitHub');
		expect(dataOf(named)).toEqual({ name: 'GitHub' });
	});

	it('starts with an empty list', async () => {
		const res = await session.get('/rest/credentials?includeScopes=true&includeData=true');
		expect(res.status).toBe(200);
		expect(dataOf(res)).toEqual([]);
	});

	it('validates the create body', async () => {
		const res = await session.post('/rest/credentials', { type: 'httpBasicAuth', data: {} });
		expect(res.status).toBe(400);
		expect(recordOf(res.body).message).toEqual(expect.any(String));
	});

	it('stores encrypted data, redacts secrets on read and keeps them on update', async () => {
		const created = await session.post('/rest/credentials', {
			name: 'My basic auth',
			type: 'httpBasicAuth',
			data: { user: 'bob', password: 's3cret' },
		});
		expect(created.status).toBe(200);
		const credential = recordOf(dataOf(created));
		const id = String(credential.id);
		expect(credential).not.toHaveProperty('data');
		expect(credential.name).toBe('My basic auth');
		expect(credential.scopes).toEqual(
			expect.arrayContaining(['credential:read', 'credential:update', 'credential:delete']),
		);
		expect(recordOf(credential.homeProject)).toMatchObject({
			id: personalProjectId,
			type: 'personal',
		});

		const ciphertext = storedData(instance, id);
		expect(ciphertext).not.toContain('s3cret');
		expect(ciphertext).not.toContain('bob');
		expect(decryptStored(ciphertext)).toEqual({ user: 'bob', password: 's3cret' });

		const read = recordOf(dataOf(await session.get(`/rest/credentials/${id}?includeData=true`)));
		expect(read.data).toEqual({ user: 'bob', password: BLANK });
		const readPlain = recordOf(dataOf(await session.get(`/rest/credentials/${id}`)));
		expect(readPlain).not.toHaveProperty('data');

		const list = arrayOf(
			dataOf(await session.get('/rest/credentials?includeScopes=true&includeData=true')),
		);
		expect(list).toHaveLength(1);
		expect(recordOf(list[0]).data).toEqual({ user: 'bob', password: BLANK });

		const patched = await session.patch(`/rest/credentials/${id}`, {
			name: 'Renamed',
			type: 'httpBasicAuth',
			data: { user: 'alice', password: BLANK },
		});
		expect(patched.status).toBe(200);
		expect(recordOf(dataOf(patched)).name).toBe('Renamed');
		expect(decryptStored(storedData(instance, id))).toEqual({ user: 'alice', password: 's3cret' });

		const next = await session.get('/rest/credentials/new');
		expect(dataOf(next)).toEqual({ name: 'My credentials' });
	});

	it('keeps secrets inside collections when the editor sends redacted data back', async () => {
		const created = await session.post('/rest/credentials', {
			name: 'Many headers',
			type: 'httpMultipleHeadersAuth',
			data: {
				headers: {
					values: [
						{ name: 'X-First', value: 'secret-one' },
						{ name: 'X-Second', value: 'secret-two' },
					],
				},
			},
		});
		expect(created.status, JSON.stringify(created.body)).toBe(200);
		const id = String(recordOf(dataOf(created)).id);

		const redacted = recordOf(
			dataOf(await session.get(`/rest/credentials/${id}?includeData=true`)),
		).data;
		expect(redacted).toEqual({
			headers: {
				values: [
					{ name: 'X-First', value: BLANK },
					{ name: 'X-Second', value: BLANK },
				],
			},
		});

		const patched = await session.patch(`/rest/credentials/${id}`, {
			data: {
				headers: {
					values: [
						{ name: 'X-Renamed', value: BLANK },
						{ name: 'X-Second', value: BLANK },
						{ name: 'X-Third', value: 'secret-three' },
					],
				},
			},
		});
		expect(patched.status, JSON.stringify(patched.body)).toBe(200);
		expect(decryptStored(storedData(instance, id))).toEqual({
			headers: {
				values: [
					{ name: 'X-Renamed', value: 'secret-one' },
					{ name: 'X-Second', value: 'secret-two' },
					{ name: 'X-Third', value: 'secret-three' },
				],
			},
		});
	});

	it('lists credentials for a project and filters by name and type', async () => {
		const forProject = arrayOf(
			dataOf(await session.get(`/rest/credentials/for-workflow?projectId=${personalProjectId}`)),
		);
		expect(forProject.map((c) => recordOf(c).name)).toContain('Renamed');
		expect(recordOf(forProject.find((c) => recordOf(c).name === 'Renamed'))).toMatchObject({
			currentUserHasAccess: true,
			sharedRoute: 'project',
		});

		const byName = await session.get(
			`/rest/credentials?filter=${encodeURIComponent(JSON.stringify({ name: 'Renam' }))}`,
		);
		expect(arrayOf(dataOf(byName))).toHaveLength(1);
		const byType = await session.get(
			`/rest/credentials?filter=${encodeURIComponent(JSON.stringify({ type: 'nope' }))}`,
		);
		expect(arrayOf(dataOf(byType))).toHaveLength(0);

		expect((await session.get('/rest/credentials/for-workflow')).status).toBe(400);
	});

	it('deletes a credential', async () => {
		const created = await session.post('/rest/credentials', {
			name: 'To delete',
			type: 'httpBasicAuth',
			data: { user: 'u', password: 'p' },
		});
		const id = String(recordOf(dataOf(created)).id);
		const res = await session.delete(`/rest/credentials/${id}`);
		expect(dataOf(res)).toBe(true);
		expect((await session.get(`/rest/credentials/${id}`)).status).toBe(404);
		expect(
			queryDb(
				instance,
				`SELECT credentialsId FROM shared_credentials WHERE credentialsId = '${id}'`,
			),
		).toEqual([]);
	});

	it('rejects a test request without credentials', async () => {
		const res = await session.post('/rest/credentials/test', {});
		expect(res.status).toBe(400);
	});
});
