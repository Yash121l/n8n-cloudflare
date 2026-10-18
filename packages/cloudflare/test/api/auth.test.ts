import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, OWNER, dataOf, recordOf, startInstance } from './harness';
import { queryDb } from './sql';

describe('auth', () => {
	let instance: Instance;
	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('rejects protected routes without a session', async () => {
		const res = await instance.session().get('/rest/login');
		expect(res.status).toBe(401);
		expect(res.body).toMatchObject({ status: 'error', message: 'Unauthorized' });
	});

	it('sets up the owner, sets the cookie and returns the public user', async () => {
		const session = instance.session();
		const res = await session.setupOwner();
		expect(res.status).toBe(200);
		const setCookie = res.headers.get('set-cookie') ?? '';
		expect(setCookie).toContain('n8n-auth=');
		expect(setCookie.toLowerCase()).toContain('httponly');
		expect(setCookie.toLowerCase()).toContain('samesite=lax');
		const user = recordOf(dataOf(res));
		expect(user).toMatchObject({
			email: OWNER.email,
			firstName: OWNER.firstName,
			role: 'global:owner',
			isOwner: true,
			isPending: false,
		});
		expect(user).not.toHaveProperty('password');
		expect(user.globalScopes).toContain('workflow:create');
	});

	it('refuses a second owner setup', async () => {
		const res = await instance
			.session()
			.post('/rest/owner/setup', { ...OWNER, email: 'other@example.com' });
		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({ message: 'Instance owner already setup' });
	});

	it('returns the current user after login', async () => {
		const session = instance.session();
		const login = await session.post('/rest/login', {
			emailOrLdapLoginId: OWNER.email.toUpperCase(),
			password: OWNER.password,
		});
		expect(login.status).toBe(200);
		const me = await session.get('/rest/login');
		expect(me.status).toBe(200);
		expect(recordOf(dataOf(me)).email).toBe(OWNER.email);
	});

	it('rejects a wrong password', async () => {
		const res = await instance.session().post('/rest/login', {
			emailOrLdapLoginId: OWNER.email,
			password: 'Wrong1234',
		});
		expect(res.status).toBe(401);
	});

	it('rejects a tampered cookie', async () => {
		const session = instance.session();
		await session.setupOwner();
		const res = await instance.worker.fetch(`${instance.origin}/rest/login`, {
			headers: { cookie: 'n8n-auth=eyJhbGciOiJIUzI1NiJ9.e30.invalid' },
		});
		expect(res.status).toBe(401);
	});

	it('invalidates the token on logout', async () => {
		const session = instance.session();
		const login = await session.post('/rest/login', {
			emailOrLdapLoginId: OWNER.email,
			password: OWNER.password,
		});
		const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
		const out = await session.post('/rest/logout');
		expect(out.status).toBe(200);
		expect(dataOf(out)).toEqual({ loggedOut: true });
		const reuse = await instance.worker.fetch(`${instance.origin}/rest/login`, {
			headers: { cookie },
		});
		expect(reuse.status).toBe(401);
	});

	it('updates profile, settings and password', async () => {
		const session = instance.session();
		await session.post('/rest/login', {
			emailOrLdapLoginId: OWNER.email,
			password: OWNER.password,
		});

		const profile = await session.patch('/rest/me', { firstName: 'Grace', lastName: 'Hopper' });
		expect(profile.status, JSON.stringify(profile.body)).toBe(200);
		expect(recordOf(dataOf(profile))).toMatchObject({ firstName: 'Grace', lastName: 'Hopper' });

		const settings = await session.patch('/rest/me/settings', { easyAIWorkflowOnboarded: true });
		expect(dataOf(settings)).toMatchObject({ easyAIWorkflowOnboarded: true });

		const survey = await session.post('/rest/me/survey', { version: 'v4', companySize: '<20' });
		expect(dataOf(survey)).toEqual({ success: true });

		const weak = await session.patch('/rest/me/password', {
			currentPassword: OWNER.password,
			newPassword: 'short',
		});
		expect(weak.status).toBe(400);

		const wrong = await session.patch('/rest/me/password', {
			currentPassword: 'Nope12345',
			newPassword: 'NewPassword1',
		});
		expect(wrong.status).toBe(400);

		const changed = await session.patch('/rest/me/password', {
			currentPassword: OWNER.password,
			newPassword: 'NewPassword1',
		});
		expect(dataOf(changed)).toEqual({ success: true });
		expect((await session.get('/rest/login')).status).toBe(200);

		const fresh = instance.session();
		expect(
			(
				await fresh.post('/rest/login', {
					emailOrLdapLoginId: OWNER.email,
					password: OWNER.password,
				})
			).status,
		).toBe(401);
		expect(
			(
				await fresh.post('/rest/login', {
					emailOrLdapLoginId: OWNER.email,
					password: 'NewPassword1',
				})
			).status,
		).toBe(200);
	});
});

describe('concurrent owner setup', () => {
	let instance: Instance;
	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('lets exactly one of several parallel requests create the owner', async () => {
		const attempts = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) =>
			instance.session().post('/rest/owner/setup', { ...OWNER, email: `${name}@example.com` }),
		);
		const results = await Promise.all(attempts);
		expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400, 400, 400, 400]);
		for (const loser of results.filter((r) => r.status === 400)) {
			expect(loser.body).toMatchObject({ message: 'Instance owner already setup' });
		}

		expect(
			queryDb(instance, "SELECT COUNT(*) AS n FROM user WHERE roleSlug = 'global:owner'"),
		).toEqual([{ n: 1 }]);
		expect(queryDb(instance, 'SELECT COUNT(*) AS n FROM user')).toEqual([{ n: 1 }]);
		expect(queryDb(instance, "SELECT COUNT(*) AS n FROM project WHERE type = 'personal'")).toEqual([
			{ n: 1 },
		]);
		expect(queryDb(instance, 'SELECT COUNT(*) AS n FROM project_relation')).toEqual([{ n: 1 }]);
	});
});
