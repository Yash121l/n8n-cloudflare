import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, recordOf, startInstance } from './harness';
import type { Session } from './harness';

const UPGRADE = {
	upgrade: 'websocket',
	connection: 'Upgrade',
	'sec-websocket-version': '13',
	'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
};

describe('push endpoint', () => {
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
		const res = await instance.session().get('/rest/push?pushRef=abc', UPGRADE);
		expect(res.status).toBe(401);
	});

	it('requires a push ref', async () => {
		const res = await session.get('/rest/push', UPGRADE);
		expect(res.status).toBe(400);
		expect(recordOf(res.body).message).toContain('pushRef');
	});

	it('rejects requests that are not WebSocket upgrades', async () => {
		const res = await session.get('/rest/push?pushRef=abc');
		expect(res.status).toBe(400);
	});

	it.each([
		['is missing', {}],
		['is malformed', { origin: 'not a url' }],
		['is not http or https', { origin: 'file:///etc/passwd' }],
		['is the opaque null origin', { origin: 'null' }],
		['has another host', { origin: 'http://evil.example' }],
	])('rejects an origin that %s', async (_name, headers) => {
		const res = await session.get('/rest/push?pushRef=abc', { ...UPGRADE, ...headers });
		expect(res.status).toBe(400);
		expect(recordOf(res.body).message).toBe('Invalid origin!');
	});

	it('hands a WebSocket upgrade with a matching origin to the push hub', async () => {
		const res = await session.get('/rest/push?pushRef=abc', {
			...UPGRADE,
			origin: instance.origin,
		});
		expect(res.status).toBe(101);
	});

	it('compares the origin with x-forwarded-host and x-forwarded-proto', async () => {
		const proxied = {
			...UPGRADE,
			origin: 'https://n8n.example.com',
			'x-forwarded-host': 'n8n.example.com:443',
			'x-forwarded-proto': 'https',
		};
		expect((await session.get('/rest/push?pushRef=abc', proxied)).status).toBe(101);
		const wrongPort = { ...proxied, 'x-forwarded-host': 'n8n.example.com:8443' };
		expect((await session.get('/rest/push?pushRef=abc', wrongPort)).status).toBe(400);
	});
});
