import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, arrayOf, dataOf, recordOf, startInstance } from './harness';
import type { Session } from './harness';
import { execDb, insertMember, insertTeamProject, literal, queryDb } from './sql';
import type { TestMember } from './sql';

const NOW = '2026-10-01T10:00:00.000Z';
const trigger = {
	name: 'Manual',
	type: 'n8n-nodes-base.manualTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const idsOf = (res: { body: unknown }, key?: string) => {
	const body = recordOf(res.body);
	return arrayOf(key ? recordOf(body.data)[key] : body.data).map((item) =>
		String(recordOf(item).id),
	);
};

async function createWorkflow(session: Session, projectId?: string): Promise<string> {
	const res = await session.post('/rest/workflows', {
		name: 'Access test',
		nodes: [trigger],
		connections: {},
		settings: { executionOrder: 'v1' },
		...(projectId ? { projectId } : {}),
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return String(recordOf(dataOf(res)).id);
}

async function createCredential(session: Session, projectId?: string): Promise<string> {
	const res = await session.post('/rest/credentials', {
		name: 'Access cred',
		type: 'httpBasicAuth',
		data: { user: 'bob', password: 's3cret' },
		...(projectId ? { projectId } : {}),
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return String(recordOf(dataOf(res)).id);
}

const scopesOf = (res: { body: unknown }): string[] =>
	arrayOf(recordOf(dataOf(res as never)).scopes).map(String);

function shareWorkflow(instance: Instance, workflowId: string, projectId: string, role: string) {
	execDb(
		instance,
		`INSERT INTO shared_workflow (workflowId, projectId, role, createdAt, updatedAt)
		VALUES (${literal(workflowId)}, ${literal(projectId)}, ${literal(role)}, ${literal(NOW)}, ${literal(NOW)})`,
	);
}

function shareCredential(
	instance: Instance,
	credentialId: string,
	projectId: string,
	role: string,
) {
	execDb(
		instance,
		`INSERT INTO shared_credentials (credentialsId, projectId, role, createdAt, updatedAt)
		VALUES (${literal(credentialId)}, ${literal(projectId)}, ${literal(role)}, ${literal(NOW)}, ${literal(NOW)})`,
	);
}

describe('resource access', () => {
	let instance: Instance;
	let owner: Session;
	let alice: Session;
	let viewer: Session;
	let editor: Session;
	let admin: Session;
	let members: Record<string, TestMember>;

	beforeAll(async () => {
		instance = await startInstance();
		owner = await instance.ownerSession();
		members = {
			alice: await insertMember(instance, 'alice'),
			viewer: await insertMember(instance, 'viewer'),
			editor: await insertMember(instance, 'editor'),
			admin: await insertMember(instance, 'admin'),
		};
		insertTeamProject(instance, 'team-1', {
			[members.viewer.id]: 'project:viewer',
			[members.editor.id]: 'project:editor',
		});
		insertTeamProject(instance, 'team-2', { [members.admin.id]: 'project:admin' });
		[alice, viewer, editor, admin] = await Promise.all(
			['alice', 'viewer', 'editor', 'admin'].map((name) => instance.memberSession(members[name])),
		);
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	describe('personal resources of another user', () => {
		let workflowId: string;
		let credentialId: string;

		beforeAll(async () => {
			workflowId = await createWorkflow(owner);
			credentialId = await createCredential(owner);
			execDb(
				instance,
				`INSERT INTO execution_entity (id, workflowId, finished, mode, status, createdAt, startedAt, stoppedAt, workflowVersionId)
				VALUES (900, ${literal(workflowId)}, 1, 'manual', 'success', ${literal(NOW)}, ${literal(NOW)}, ${literal(NOW)}, 'v1')`,
			);
		});

		it('hides the workflow from reads and updates', async () => {
			const read = await alice.get(`/rest/workflows/${workflowId}`);
			expect([403, 404]).toContain(read.status);
			const update = await alice.patch(`/rest/workflows/${workflowId}`, { name: 'Hijacked' });
			expect([403, 404]).toContain(update.status);
			expect(
				queryDb(instance, `SELECT name FROM workflow_entity WHERE id = ${literal(workflowId)}`),
			).toEqual([{ name: 'Access test' }]);
		});

		it('leaves it out of the workflow, active and execution lists', async () => {
			expect(idsOf(await alice.get('/rest/workflows'))).not.toContain(workflowId);
			expect(await alice.get('/rest/active-workflows').then((r) => idsOf(r))).not.toContain(
				workflowId,
			);
			const executions = recordOf(dataOf(await alice.get('/rest/executions')));
			expect(arrayOf(executions.results)).toEqual([]);
			expect((await alice.get('/rest/executions/900')).body).toEqual({});
		});

		it('hides the credential from reads, updates, deletes and lists', async () => {
			expect((await alice.get(`/rest/credentials/${credentialId}`)).status).toBe(404);
			expect(
				(await alice.patch(`/rest/credentials/${credentialId}`, { name: 'Hijacked' })).status,
			).toBe(404);
			expect((await alice.delete(`/rest/credentials/${credentialId}`)).status).toBe(404);
			expect(idsOf(await alice.get('/rest/credentials'))).not.toContain(credentialId);
		});

		it('keeps everything visible to the instance owner', async () => {
			const aliceWorkflow = await createWorkflow(alice, members.alice.personalProjectId);
			const aliceCredential = await createCredential(alice);

			const read = await owner.get(`/rest/workflows/${aliceWorkflow}`);
			expect(read.status).toBe(200);
			expect(scopesOf(read)).toEqual(
				expect.arrayContaining(['workflow:update', 'workflow:delete']),
			);
			expect(idsOf(await owner.get('/rest/workflows'))).toEqual(
				expect.arrayContaining([workflowId, aliceWorkflow]),
			);
			expect(idsOf(await owner.get('/rest/credentials'))).toEqual(
				expect.arrayContaining([credentialId, aliceCredential]),
			);
			const executions = recordOf(dataOf(await owner.get('/rest/executions')));
			expect(arrayOf(executions.results).map((r) => recordOf(r).id)).toContain('900');
			expect(
				(await owner.patch(`/rest/credentials/${aliceCredential}`, { name: 'Renamed by owner' }))
					.status,
			).toBe(200);
		});

		it('requires workflow:execute to cancel a test listener', async () => {
			expect([403, 404]).toContain((await alice.delete(`/rest/test-webhook/${workflowId}`)).status);
			expect((await owner.delete(`/rest/test-webhook/${workflowId}`)).status).toBe(200);
		});
	});

	describe('team project roles', () => {
		let workflowId: string;
		let credentialId: string;

		beforeAll(async () => {
			workflowId = await createWorkflow(owner, 'team-1');
			credentialId = await createCredential(owner, 'team-1');
		});

		it('lets a project viewer read but not change the credential', async () => {
			const read = await viewer.get(`/rest/credentials/${credentialId}`);
			expect(read.status).toBe(200);
			expect(scopesOf(read)).toContain('credential:read');
			expect(scopesOf(read)).not.toContain('credential:update');
			expect(scopesOf(read)).not.toContain('credential:delete');
			expect(
				(await viewer.patch(`/rest/credentials/${credentialId}`, { name: 'Changed' })).status,
			).toBe(404);
			expect((await viewer.delete(`/rest/credentials/${credentialId}`)).status).toBe(404);
			expect(idsOf(await viewer.get('/rest/credentials'))).toContain(credentialId);
		});

		it('lets a project viewer read but not change or run the workflow', async () => {
			const read = await viewer.get(`/rest/workflows/${workflowId}`);
			expect(read.status).toBe(200);
			expect(scopesOf(read)).toEqual(expect.arrayContaining(['workflow:read']));
			expect(scopesOf(read)).not.toContain('workflow:update');
			expect(
				(await viewer.patch(`/rest/workflows/${workflowId}`, { name: 'Changed' })).status,
			).toBe(403);
			expect((await viewer.delete(`/rest/test-webhook/${workflowId}`)).status).toBe(403);
			expect(idsOf(await viewer.get('/rest/workflows'))).toContain(workflowId);
		});

		it('lets a project editor change the credential and the workflow', async () => {
			expect(
				(await editor.patch(`/rest/credentials/${credentialId}`, { name: 'Edited' })).status,
			).toBe(200);
			expect((await editor.patch(`/rest/workflows/${workflowId}`, { name: 'Edited' })).status).toBe(
				200,
			);
			expect((await editor.delete(`/rest/test-webhook/${workflowId}`)).status).toBe(200);
		});

		it('caps a project admin at the sharing role of the credential', async () => {
			shareCredential(instance, credentialId, 'team-2', 'credential:user');
			const read = await admin.get(`/rest/credentials/${credentialId}`);
			expect(read.status).toBe(200);
			expect(scopesOf(read)).toContain('credential:read');
			expect(scopesOf(read)).not.toContain('credential:update');
			expect(
				(await admin.patch(`/rest/credentials/${credentialId}`, { name: 'Changed' })).status,
			).toBe(404);
			expect((await admin.delete(`/rest/credentials/${credentialId}`)).status).toBe(404);
		});

		it('caps a project admin at the sharing role of the workflow', async () => {
			shareWorkflow(instance, workflowId, 'team-2', 'workflow:editor');
			const read = await admin.get(`/rest/workflows/${workflowId}`);
			expect(read.status).toBe(200);
			expect(scopesOf(read)).toContain('workflow:update');
			expect(scopesOf(read)).not.toContain('workflow:delete');
			expect(
				(await admin.patch(`/rest/workflows/${workflowId}`, { name: 'Edited by admin' })).status,
			).toBe(200);
			expect((await admin.post(`/rest/workflows/${workflowId}/archive`, {})).status).toBe(403);
		});

		it('gives no access to a project the user does not belong to', async () => {
			const hidden = await createWorkflow(owner, 'team-2');
			expect((await viewer.get(`/rest/workflows/${hidden}`)).status).toBe(403);
			expect(idsOf(await viewer.get('/rest/workflows'))).not.toContain(hidden);
		});
	});
});
