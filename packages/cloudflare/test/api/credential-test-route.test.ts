import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CREDENTIAL_BLANKING_VALUE } from 'n8n-workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, dataOf, recordOf, startInstance } from './harness';
import type { Session } from './harness';
import { insertMember, insertTeamProject } from './sql';

const STORED_KEY = 'stored-owner-key-0123';

/** Stands in for the server an attacker runs. It records every request it gets. */
function listen(): Promise<{ server: Server; origin: string; received: string[] }> {
	const received: string[] = [];
	const server = createServer((req, res) => {
		received.push(String(req.headers.authorization ?? 'no authorization header'));
		res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			resolve({
				server,
				origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				received,
			});
		});
	});
}

describe('credential test route', () => {
	let instance: Instance;
	let owner: Session;
	let viewer: Session;
	let member: Session;
	let attacker: Awaited<ReturnType<typeof listen>>;
	let teamCredentialId: string;
	let globalCredentialId: string;

	const create = async (projectId?: string) => {
		const res = await owner.post('/rest/credentials', {
			name: 'Grafana',
			type: 'grafanaApi',
			projectId,
			// The stored address points nowhere, so only a request body can send the key to the attacker.
			data: { apiKey: STORED_KEY, baseUrl: 'http://127.0.0.1:1' },
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return String(recordOf(dataOf(res)).id);
	};

	const testWith = (
		session: Session,
		id: string,
		type = 'grafanaApi',
		data: Record<string, unknown> = {},
	) => session.post('/rest/credentials/test', { credentials: { id, name: 'Grafana', type, data } });

	beforeAll(async () => {
		attacker = await listen();
		instance = await startInstance();
		owner = await instance.ownerSession();
		const viewerUser = await insertMember(instance, 'viewer');
		const memberUser = await insertMember(instance, 'plain');
		insertTeamProject(instance, 'team-one', { [viewerUser.id]: 'project:viewer' });
		viewer = await instance.memberSession(viewerUser);
		member = await instance.memberSession(memberUser);

		teamCredentialId = await create('team-one');
		globalCredentialId = await create();
		const global = await owner.patch(`/rest/credentials/${globalCredentialId}`, { isGlobal: true });
		expect(global.status, JSON.stringify(global.body)).toBe(200);
	});
	afterAll(async () => {
		await instance?.dispose();
		attacker?.server.close();
	});

	it('tests only the stored data when a project viewer sends other data', async () => {
		attacker.received.length = 0;
		const res = await testWith(viewer, teamCredentialId, 'grafanaApi', {
			apiKey: CREDENTIAL_BLANKING_VALUE,
			baseUrl: attacker.origin,
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(attacker.received).toEqual([]);
	});

	it('tests only the stored data when a member uses a global credential', async () => {
		attacker.received.length = 0;
		const res = await testWith(member, globalCredentialId, 'grafanaApi', {
			apiKey: CREDENTIAL_BLANKING_VALUE,
			baseUrl: attacker.origin,
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(attacker.received).toEqual([]);
	});

	it('rejects a type that differs from the stored credential', async () => {
		const res = await testWith(viewer, teamCredentialId, 'httpBasicAuth', {
			user: 'a',
			password: 'b',
		});
		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({
			message: 'The credential type does not match the stored credential',
		});
	});

	it('lets an editor test unsaved changes', async () => {
		attacker.received.length = 0;
		const res = await testWith(owner, teamCredentialId, 'grafanaApi', {
			apiKey: 'typed-by-the-editor',
			baseUrl: attacker.origin,
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(attacker.received).toEqual(['Bearer typed-by-the-editor']);
	});

	it('fills a redacted secret from the stored data for an editor', async () => {
		attacker.received.length = 0;
		await testWith(owner, teamCredentialId, 'grafanaApi', {
			apiKey: CREDENTIAL_BLANKING_VALUE,
			baseUrl: attacker.origin,
		});
		expect(attacker.received).toEqual([`Bearer ${STORED_KEY}`]);
	});
});
