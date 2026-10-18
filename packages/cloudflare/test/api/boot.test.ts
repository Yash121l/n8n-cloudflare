import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, OWNER, arrayOf, dataOf, recordOf, startInstance } from './harness';

describe('editor boot endpoints', () => {
	let instance: Instance;
	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('serves public settings before login and asks for owner setup', async () => {
		const res = await instance.session().get('/rest/settings');
		expect(res.status).toBe(200);
		const settings = recordOf(dataOf(res));
		expect(settings.settingsMode).toBe('public');
		expect(recordOf(settings.userManagement).showSetupOnFirstLoad).toBe(true);
		expect(settings).not.toHaveProperty('versionCli');
		expect(settings).not.toHaveProperty('enterprise.sharing');
	});

	it('serves full settings after login with the fields the editor dereferences', async () => {
		const session = await instance.ownerSession();
		const publicAfterSetup = await instance.session().get('/rest/settings');
		expect(recordOf(recordOf(dataOf(publicAfterSetup)).userManagement).showSetupOnFirstLoad).toBe(
			false,
		);

		const res = await session.get('/rest/settings');
		const settings = recordOf(dataOf(res));
		expect(settings.settingsMode).toBe('authenticated');
		expect(settings.pushBackend).toBe('websocket');
		expect(settings.endpointHealth).toBe('/healthz');
		expect(settings.versionCli).toBe('2.44.0');
		expect(settings.activeModules).toEqual([]);
		expect(settings.telemetry).toEqual({ enabled: false });
		expect(recordOf(settings.templates).enabled).toBe(false);
		expect(recordOf(settings.versionNotifications).enabled).toBe(false);
		expect(recordOf(settings.enterprise).sharing).toBe(false);
		expect(recordOf(recordOf(settings.enterprise).projects)).toEqual({ team: { limit: 0 } });
		expect(recordOf(settings.userManagement)).toMatchObject({
			authenticationMethod: 'email',
			showSetupOnFirstLoad: false,
		});
		for (const key of [
			'sso',
			'banners',
			'publicApi',
			'mfa',
			'folders',
			'license',
			'oauthCallbackUrls',
			'posthog',
		]) {
			expect(settings[key], key).toBeDefined();
		}
		expect(recordOf(settings.authCookie).secure).toBe(false);
	});

	it('returns the four calls the editor awaits before rendering', async () => {
		const session = await instance.ownerSession();

		const mine = arrayOf(dataOf(await session.get('/rest/projects/my-projects')));
		expect(mine).toHaveLength(1);
		const personal = recordOf(mine[0]);
		expect(personal).toMatchObject({ type: 'personal', role: 'project:personalOwner' });
		expect(personal.name).toBe(`${OWNER.firstName} ${OWNER.lastName} <${OWNER.email}>`);
		expect(personal.scopes).toEqual(
			expect.arrayContaining(['workflow:create', 'workflow:update', 'workflow:execute']),
		);

		const project = recordOf(dataOf(await session.get('/rest/projects/personal')));
		expect(project.id).toBe(personal.id);
		expect(project.scopes).toEqual(expect.arrayContaining(['project:read', 'credential:create']));

		expect(dataOf(await session.get('/rest/projects/count'))).toEqual({
			personal: 1,
			team: 0,
			public: 0,
		});

		const roles = recordOf(dataOf(await session.get('/rest/roles?withUsageCount=true')));
		expect(Object.keys(roles)).toEqual(
			expect.arrayContaining(['global', 'project', 'credential', 'workflow']),
		);
		const globalRoles = arrayOf(roles.global).map(recordOf);
		expect(globalRoles.find((role) => role.slug === 'global:owner')).toMatchObject({
			usedByUsers: 1,
		});
		expect(arrayOf(roles.workflow).map((role) => recordOf(role).slug)).toContain('workflow:owner');
	});

	it('returns a project with relations and a project list', async () => {
		const session = await instance.ownerSession();
		const mine = arrayOf(dataOf(await session.get('/rest/projects/my-projects')));
		const id = String(recordOf(mine[0]).id);

		const detail = recordOf(dataOf(await session.get(`/rest/projects/${id}`)));
		expect(arrayOf(detail.relations).map((r) => recordOf(r).email)).toEqual([OWNER.email]);
		expect(detail.rolesManaged).toBe(false);

		const list = await session.get('/rest/projects?take=10&skip=0');
		expect(list.body).toMatchObject({ count: 1 });
		expect(arrayOf(recordOf(list.body).data)).toHaveLength(1);

		expect((await session.get('/rest/projects/does-not-exist')).status).toBe(404);
		expect((await session.post('/rest/projects', { name: 'Team' })).status).toBe(403);
	});

	it('stores dismissed banners', async () => {
		const session = await instance.ownerSession();
		const res = await session.post('/rest/owner/dismiss-banner', { banner: 'V1' });
		expect(res.status).toBe(200);
		const settings = recordOf(dataOf(await session.get('/rest/settings')));
		expect(recordOf(settings.banners).dismissed).toEqual(['V1']);
	});

	it('lists users and module settings', async () => {
		const session = await instance.ownerSession();
		const users = recordOf(dataOf(await session.get('/rest/users?take=10')));
		expect(users.count).toBe(1);
		expect(recordOf(arrayOf(users.items)[0])).toMatchObject({
			email: OWNER.email,
			role: 'global:owner',
		});
		expect(dataOf(await session.get('/rest/module-settings'))).toEqual({});
	});

	it('requires a session for boot endpoints', async () => {
		const anon = instance.session();
		for (const path of [
			'/rest/projects/my-projects',
			'/rest/projects/personal',
			'/rest/projects/count',
			'/rest/roles',
			'/rest/users',
			'/rest/module-settings',
		]) {
			expect((await anon.get(path)).status, path).toBe(401);
		}
	});
});
