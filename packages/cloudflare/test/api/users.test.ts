import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, OWNER, arrayOf, dataOf, recordOf, startInstance } from './harness';
import type { Session } from './harness';
import { literal, queryDb } from './sql';

const trigger = {
	name: 'Manual',
	type: 'n8n-nodes-base.manualTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};
const PASSWORD = 'Password123';

async function createWorkflow(session: Session, name: string): Promise<string> {
	const res = await session.post('/rest/workflows', {
		name,
		nodes: [trigger],
		connections: {},
		settings: {},
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return String(recordOf(dataOf(res)).id);
}

async function createCredential(session: Session, name: string): Promise<string> {
	const res = await session.post('/rest/credentials', {
		name,
		type: 'httpBasicAuth',
		data: { user: 'u', password: 'p' },
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return String(recordOf(dataOf(res)).id);
}

const tokenOf = (link: string) => new URL(link).searchParams.get('token') ?? '';

describe('user management', () => {
	let instance: Instance;
	let owner: Session;
	let ownerProjectId: string;

	/** Invites `name`, accepts the invite and returns the logged-in session of the new user. */
	async function inviteAndAccept(
		name: string,
		role = 'global:member',
	): Promise<{ id: string; session: Session }> {
		const invite = await owner.post('/rest/invitations', [{ email: `${name}@example.com`, role }]);
		expect(invite.status, JSON.stringify(invite.body)).toBe(200);
		const user = recordOf(recordOf(arrayOf(dataOf(invite))[0]).user);
		const session = instance.session();
		const accept = await session.post('/rest/invitations/accept', {
			token: tokenOf(String(user.inviteAcceptUrl)),
			firstName: name,
			lastName: 'Tester',
			password: PASSWORD,
		});
		expect(accept.status, JSON.stringify(accept.body)).toBe(200);
		return { id: String(user.id), session };
	}

	beforeAll(async () => {
		instance = await startInstance();
		owner = await instance.ownerSession();
		ownerProjectId = String(recordOf(dataOf(await owner.get('/rest/projects/personal'))).id);
	});

	afterAll(async () => {
		await instance?.dispose();
	});

	it('advertises no email delivery, so the editor shows invite links', async () => {
		const settings = recordOf(dataOf(await owner.get('/rest/settings')));
		expect(recordOf(settings.userManagement).smtpSetup).toBe(false);
		expect(recordOf(settings.enterprise).advancedPermissions).toBe(true);
	});

	it('invites a user, creates a pending shell with a personal project, and returns the link', async () => {
		const res = await owner.post('/rest/invitations', [
			{ email: 'Bob@Example.com', role: 'global:member' },
		]);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const [entry] = arrayOf(dataOf(res)).map(recordOf);
		expect(entry.error).toBe('');
		const user = recordOf(entry.user);
		expect(user).toMatchObject({
			email: 'bob@example.com',
			emailSent: false,
			role: 'global:member',
		});
		expect(String(user.inviteAcceptUrl)).toMatch(/\/signup\?token=/);

		const rows = queryDb(
			instance,
			`SELECT u.password, u.roleSlug, r.role, p.type, p.name FROM user u
			JOIN project_relation r ON r.userId = u.id JOIN project p ON p.id = r.projectId
			WHERE u.id = ${literal(String(user.id))}`,
		);
		expect(rows).toEqual([
			{
				password: null,
				roleSlug: 'global:member',
				role: 'project:personalOwner',
				type: 'personal',
				name: '<bob@example.com>',
			},
		]);

		const pending = recordOf(
			dataOf(
				await owner.get(`/rest/users?filter=${encodeURIComponent('{"isPending":true}')}&take=10`),
			),
		);
		expect(pending.count).toBe(1);
		expect(recordOf(arrayOf(pending.items)[0])).toMatchObject({
			email: 'bob@example.com',
			isPending: true,
		});

		// Inviting a pending user again returns a fresh link and creates nothing.
		const again = await owner.post('/rest/invitations', [
			{ email: 'bob@example.com', role: 'global:member' },
		]);
		expect(recordOf(recordOf(arrayOf(dataOf(again))[0]).user).id).toBe(user.id);
		expect(
			queryDb(instance, "SELECT COUNT(*) AS n FROM user WHERE email = 'bob@example.com'"),
		).toEqual([{ n: 1 }]);
	});

	it('resolves the signup token and accepts the invitation once', async () => {
		const bob = recordOf(
			queryDb(instance, "SELECT id FROM user WHERE email = 'bob@example.com'")[0],
		);
		const link = recordOf(
			dataOf(await owner.post(`/rest/users/${String(bob.id)}/invite-link`)),
		).link;
		const token = tokenOf(String(link));

		const anonymous = instance.session();
		const resolved = await anonymous.get(`/rest/resolve-signup-token?token=${token}`);
		expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
		expect(dataOf(resolved)).toEqual({
			inviter: { firstName: OWNER.firstName, lastName: OWNER.lastName },
		});
		expect((await anonymous.get('/rest/resolve-signup-token?token=nope')).status).toBe(400);

		const accept = await anonymous.post('/rest/invitations/accept', {
			token,
			firstName: 'Bob',
			lastName: 'Builder',
			password: PASSWORD,
		});
		expect(accept.status, JSON.stringify(accept.body)).toBe(200);
		expect(recordOf(dataOf(accept))).toMatchObject({
			email: 'bob@example.com',
			isPending: false,
			role: 'global:member',
		});
		expect(anonymous.hasCookie).toBe(true);
		expect((await anonymous.get('/rest/login')).status).toBe(200);

		const project = queryDb(
			instance,
			`SELECT name FROM project WHERE creatorId = ${literal(String(bob.id))} AND type = 'personal'`,
		);
		expect(project).toEqual([{ name: 'Bob Builder <bob@example.com>' }]);

		const reused = await instance.session().post('/rest/invitations/accept', {
			token,
			firstName: 'Mallory',
			lastName: 'X',
			password: PASSWORD,
		});
		expect(reused.status).toBe(400);
		expect((await instance.session().get(`/rest/resolve-signup-token?token=${token}`)).status).toBe(
			400,
		);
	});

	it('lets the member log in but not see the owner workflow or manage users', async () => {
		const member = await instance.memberSession({ email: 'bob@example.com', password: PASSWORD });
		const ownerWorkflow = await createWorkflow(owner, 'Owner only');
		const memberWorkflow = await createWorkflow(member, 'Bob workflow');

		const ids = (res: { body: unknown }) =>
			arrayOf(recordOf(res.body).data).map((w) => recordOf(w).id);
		const memberList = ids(await member.get('/rest/workflows'));
		expect(memberList).toContain(memberWorkflow);
		expect(memberList).not.toContain(ownerWorkflow);
		expect((await member.get(`/rest/workflows/${ownerWorkflow}`)).status).not.toBe(200);
		expect(ids(await owner.get('/rest/workflows'))).toEqual(
			expect.arrayContaining([ownerWorkflow, memberWorkflow]),
		);

		expect(
			(await member.post('/rest/invitations', [{ email: 'x@example.com', role: 'global:member' }]))
				.status,
		).toBe(403);
		const users = recordOf(dataOf(await member.get('/rest/users?take=10')));
		const ownerItem = recordOf(arrayOf(users.items).find((u) => recordOf(u).email === OWNER.email));
		expect(ownerItem).not.toHaveProperty('isPending');
		expect(ownerItem).not.toHaveProperty('settings');
	});

	it('lists users with the stock select, sort and pagination', async () => {
		const res = await owner.get(
			'/rest/users?select[]=email&select[]=role&sortBy[]=email:desc&take=1&skip=0',
		);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const list = recordOf(dataOf(res));
		expect(list.count).toBe(2);
		expect(list.items).toEqual([{ email: OWNER.email, role: 'global:owner' }]);
	});

	it('changes the global role of a user', async () => {
		const { id, session } = await inviteAndAccept('erin');
		expect((await session.get('/rest/users/x/password-reset-link')).status).toBe(403);

		const promoted = await owner.patch(`/rest/users/${id}/role`, { newRoleName: 'global:admin' });
		expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
		const me = recordOf(dataOf(await session.get('/rest/login')));
		expect(me.role).toBe('global:admin');
		expect(arrayOf(me.globalScopes)).toContain('user:create');

		const ownerId = String(recordOf(dataOf(await owner.get('/rest/login'))).id);
		expect(
			(await session.patch(`/rest/users/${ownerId}/role`, { newRoleName: 'global:member' })).status,
		).toBe(403);
		expect(
			(await owner.patch(`/rest/users/${ownerId}/role`, { newRoleName: 'global:member' })).status,
		).toBe(403);
		expect(
			(await owner.patch(`/rest/users/${id}/role`, { newRoleName: 'global:owner' })).status,
		).toBe(400);

		const chat = await owner.patch(`/rest/users/${id}/role`, { newRoleName: 'global:chatUser' });
		expect(chat.status, JSON.stringify(chat.body)).toBe(200);
		expect(
			queryDb(instance, `SELECT role FROM project_relation WHERE userId = ${literal(id)}`),
		).toEqual([{ role: 'project:viewer' }]);
		await owner.patch(`/rest/users/${id}/role`, { newRoleName: 'global:member' });
		expect(
			queryDb(instance, `SELECT role FROM project_relation WHERE userId = ${literal(id)}`),
		).toEqual([{ role: 'project:personalOwner' }]);
	});

	it('deletes a user and transfers the workflows and credentials', async () => {
		const { id, session } = await inviteAndAccept('carol');
		const workflowId = await createWorkflow(session, 'Carol workflow');
		const credentialId = await createCredential(session, 'Carol cred');

		expect((await owner.delete(`/rest/users/${id}?transferId=nope`)).status).toBe(404);
		const res = await owner.delete(`/rest/users/${id}?transferId=${ownerProjectId}`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);

		expect(queryDb(instance, `SELECT COUNT(*) AS n FROM user WHERE id = ${literal(id)}`)).toEqual([
			{ n: 0 },
		]);
		expect(
			queryDb(instance, `SELECT COUNT(*) AS n FROM project WHERE creatorId = ${literal(id)}`),
		).toEqual([{ n: 0 }]);
		expect(
			queryDb(
				instance,
				`SELECT projectId, role FROM shared_workflow WHERE workflowId = ${literal(workflowId)}`,
			),
		).toEqual([{ projectId: ownerProjectId, role: 'workflow:owner' }]);
		expect(
			queryDb(
				instance,
				`SELECT projectId, role FROM shared_credentials WHERE credentialsId = ${literal(credentialId)}`,
			),
		).toEqual([{ projectId: ownerProjectId, role: 'credential:owner' }]);
		expect((await owner.get(`/rest/workflows/${workflowId}`)).status).toBe(200);
		expect((await session.get('/rest/login')).status).toBe(401);
	});

	it('deletes a user without transfer, together with what the user owns', async () => {
		const { id, session } = await inviteAndAccept('dave');
		const workflowId = await createWorkflow(session, 'Dave workflow');
		const credentialId = await createCredential(session, 'Dave cred');

		const res = await owner.delete(`/rest/users/${id}`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(
			queryDb(
				instance,
				`SELECT COUNT(*) AS n FROM workflow_entity WHERE id = ${literal(workflowId)}`,
			),
		).toEqual([{ n: 0 }]);
		expect(
			queryDb(
				instance,
				`SELECT COUNT(*) AS n FROM credentials_entity WHERE id = ${literal(credentialId)}`,
			),
		).toEqual([{ n: 0 }]);
	});

	it('refuses to delete the owner or oneself', async () => {
		const ownerId = String(recordOf(dataOf(await owner.get('/rest/login'))).id);
		expect((await owner.delete(`/rest/users/${ownerId}`)).status).toBe(400);
		const { session } = await inviteAndAccept('frank', 'global:admin');
		expect((await session.delete(`/rest/users/${ownerId}`)).status).toBe(403);
	});

	it('resets a password with a link from the owner', async () => {
		const { id } = await inviteAndAccept('grace');
		const anonymous = instance.session();
		expect(
			(await anonymous.post('/rest/forgot-password', { email: 'grace@example.com' })).status,
		).toBe(422);

		const linkRes = await owner.get(`/rest/users/${id}/password-reset-link`);
		expect(linkRes.status, JSON.stringify(linkRes.body)).toBe(200);
		const link = String(recordOf(dataOf(linkRes)).link);
		expect(link).toMatch(/\/change-password\?token=.+&mfaEnabled=false$/);
		const token = tokenOf(link);

		expect((await anonymous.get(`/rest/resolve-password-token?token=${token}`)).status).toBe(200);
		expect(
			(await anonymous.get('/rest/resolve-password-token?token=not-a-real-token')).status,
		).toBe(404);
		expect(
			(await anonymous.post('/rest/change-password', { token, password: 'short' })).status,
		).toBe(400);

		const changed = await anonymous.post('/rest/change-password', {
			token,
			password: 'NewPassword9',
		});
		expect(changed.status, JSON.stringify(changed.body)).toBe(200);
		expect(anonymous.hasCookie).toBe(true);

		const login = (password: string) =>
			instance.session().post('/rest/login', { emailOrLdapLoginId: 'grace@example.com', password });
		expect((await login(PASSWORD)).status).toBe(401);
		expect((await login('NewPassword9')).status).toBe(200);
		expect(
			(await instance.session().get(`/rest/resolve-password-token?token=${token}`)).status,
		).toBe(404);
		expect(
			(await instance.session().post('/rest/change-password', { token, password: 'Another123' }))
				.status,
		).toBe(404);
	});
});
