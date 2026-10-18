import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, dataOf, recordOf, startInstance } from './harness';
import type { Session } from './harness';
import { execDb, insertMember, literal } from './sql';
import type { TestMember } from './sql';

const NOW = '2026-10-01T10:00:00.000Z';

const manual = {
	id: '1',
	name: 'Manual',
	type: 'n8n-nodes-base.manualTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const httpNode = (credentialId: string | null) => ({
	id: '2',
	name: 'HTTP Request',
	type: 'n8n-nodes-base.httpRequest',
	typeVersion: 4.2,
	position: [200, 0],
	parameters: {
		url: 'http://127.0.0.1:1/',
		authentication: 'genericCredentialType',
		genericAuthType: 'httpBasicAuth',
	},
	credentials: { httpBasicAuth: { id: credentialId, name: 'Basic' } },
});

async function createCredential(session: Session): Promise<string> {
	const res = await session.post('/rest/credentials', {
		name: 'Basic',
		type: 'httpBasicAuth',
		data: { user: 'bob', password: 's3cret' },
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return String(recordOf(dataOf(res)).id);
}

async function createWorkflow(session: Session, credentialId: string | null) {
	const res = await session.post('/rest/workflows', {
		name: 'Credential access',
		nodes: [manual, httpNode(credentialId)],
		connections: { Manual: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] } },
		settings: { executionOrder: 'v1' },
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return recordOf(dataOf(res));
}

const run = (session: Session, workflow: Record<string, unknown>) =>
	session.post(`/rest/workflows/${String(workflow.id)}/run`, {
		workflowData: workflow,
		triggerToStartFrom: { name: 'Manual' },
	});

describe('credential access', () => {
	let instance: Instance;
	let owner: Session;
	let alice: Session;
	let aliceMember: TestMember;
	let ownerCredential: string;

	beforeAll(async () => {
		instance = await startInstance();
		owner = await instance.ownerSession();
		aliceMember = await insertMember(instance, 'alice');
		alice = await instance.memberSession(aliceMember);
		ownerCredential = await createCredential(owner);
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('stops a manual run that uses a credential which is not shared with the workflow', async () => {
		const workflow = await createWorkflow(alice, ownerCredential);
		const res = await run(alice, workflow);
		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({
			message: 'Node "HTTP Request" does not have access to the credential',
			hint: 'Please recreate the credential or ask its owner to share it with you.',
		});
	});

	it('runs with a credential of the same user', async () => {
		const own = await createCredential(alice);
		const res = await run(alice, await createWorkflow(alice, own));
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(recordOf(dataOf(res)).executionId).toBeDefined();
	});

	it('refuses a credential without an id as invalid', async () => {
		const res = await run(alice, await createWorkflow(alice, null));
		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({ message: 'Node "HTTP Request" uses invalid credential' });
	});

	it('rejects a dropdown request that names a credential the user cannot read', async () => {
		const payload = (id: string) => ({
			nodeTypeAndVersion: { name: 'n8n-nodes-base.httpRequest', version: 4.2 },
			path: 'parameters.url',
			methodName: 'noSuchMethod',
			currentNodeParameters: {},
			credentials: { httpBasicAuth: { id, name: 'Basic' } },
		});
		const denied = await alice.post(
			'/rest/dynamic-node-parameters/options',
			payload(ownerCredential),
		);
		expect(denied.status).toBe(403);

		const own = await createCredential(alice);
		const allowed = await alice.post('/rest/dynamic-node-parameters/options', payload(own));
		expect(allowed.status, JSON.stringify(allowed.body)).not.toBe(403);
	});

	it('lets the workflow use the credential once it is shared with the project of the workflow', async () => {
		const workflow = await createWorkflow(alice, ownerCredential);
		execDb(
			instance,
			`INSERT INTO shared_credentials (credentialsId, projectId, role, createdAt, updatedAt)
			VALUES (${literal(ownerCredential)}, ${literal(aliceMember.personalProjectId)}, 'credential:user', ${literal(NOW)}, ${literal(NOW)})`,
		);
		const res = await run(alice, workflow);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
	});
});
