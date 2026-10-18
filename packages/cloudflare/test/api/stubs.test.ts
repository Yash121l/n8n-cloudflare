import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, Session, arrayOf, dataOf, recordOf, startInstance } from './harness';

describe('stub endpoints', () => {
	let instance: Instance;
	let owner: Session;

	beforeAll(async () => {
		instance = await startInstance();
		owner = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	describe('auth boundary', () => {
		it.each([
			['GET', '/rest/favorites'],
			['GET', '/rest/license'],
			['GET', '/rest/community-packages'],
			['GET', '/rest/ldap/config'],
			['POST', '/rest/webhooks/find'],
		])('%s %s needs a session', async (method, path) => {
			const res = await instance
				.session()
				.request(method, path, method === 'POST' ? {} : undefined);
			expect(res.status).toBe(401);
		});

		it('answers unknown /rest routes with a JSON 404', async () => {
			const res = await owner.get('/rest/no-such-endpoint');
			expect(res.status).toBe(404);
			expect(recordOf(res.body)).toMatchObject({ code: 404, message: 'Not Found' });
		});
	});

	describe('live helpers', () => {
		it('lists timezones as a name to label map', async () => {
			const res = await owner.get('/rest/options/timezones');
			expect(res.status).toBe(200);
			const zones = recordOf(dataOf(res));
			expect(zones['Europe/Berlin']).toBe('Europe/Berlin');
			expect(zones['America/New_York']).toBe('America/New York');
			expect(zones['Etc/UTC']).toBe('Etc/UTC');
		});

		it('reports usage and the community plan', async () => {
			const res = await owner.get('/rest/license');
			expect(res.status).toBe(200);
			expect(dataOf(res)).toEqual({
				usage: {
					activeWorkflowTriggers: { value: 0, limit: -1, warningThreshold: 0.8 },
					workflowsHavingEvaluations: { value: 0, limit: -1 },
				},
				license: { planId: '', planName: 'Community' },
			});
		});

		it('refuses license changes', async () => {
			const res = await owner.post('/rest/license/activate', { activationKey: 'x' });
			expect(res.status).toBe(400);
		});

		it('accepts the session-started event', async () => {
			const res = await owner.get('/rest/events/session-started');
			expect(res.status).toBe(200);
		});

		it('returns null when no webhook uses the path', async () => {
			const res = await owner.post('/rest/webhooks/find', { path: 'nothing-here', method: 'GET' });
			expect(res.status).toBe(200);
			expect(dataOf(res)).toBeNull();
		});

		it('stores the NPS survey state in the user settings', async () => {
			const state = { lastShownAt: 1_700_000_000_000, waitingForResponse: true, ignoredCount: 2 };
			expect((await owner.patch('/rest/user-settings/nps-survey', state)).status).toBe(200);
			const me = recordOf(dataOf(await owner.get('/rest/login')));
			expect(recordOf(me.settings).npsSurvey).toEqual(state);
		});

		it('rejects a malformed NPS survey state', async () => {
			const res = await owner.patch('/rest/user-settings/nps-survey', { lastShownAt: 'now' });
			expect(res.status).toBe(400);
		});

		it('remembers dismissed banners', async () => {
			expect((await owner.post('/rest/owner/dismiss-banner', { banner: 'V1' })).status).toBe(200);
			const settings = recordOf(dataOf(await owner.get('/rest/settings')));
			expect(recordOf(settings.banners).dismissed).toEqual(['V1']);
		});
	});

	describe('favorites', () => {
		it('adds, lists and removes a project favorite', async () => {
			expect(arrayOf(dataOf(await owner.get('/rest/favorites')))).toEqual([]);

			const personal = recordOf(dataOf(await owner.get('/rest/projects/personal')));
			const projectId = String(personal.id);

			const added = await owner.post('/rest/favorites', {
				resourceId: projectId,
				resourceType: 'project',
			});
			expect(added.status).toBe(200);
			expect(recordOf(dataOf(added))).toMatchObject({
				resourceId: projectId,
				resourceType: 'project',
				resourceName: personal.name,
			});

			const again = await owner.post('/rest/favorites', {
				resourceId: projectId,
				resourceType: 'project',
			});
			expect(recordOf(dataOf(again)).id).toBe(recordOf(dataOf(added)).id);
			expect(arrayOf(dataOf(await owner.get('/rest/favorites')))).toHaveLength(1);

			const removed = await owner.delete(`/rest/favorites/project/${projectId}`);
			expect(dataOf(removed)).toBe(true);
			expect(arrayOf(dataOf(await owner.get('/rest/favorites')))).toEqual([]);
		});

		it('rejects unknown resources and types', async () => {
			expect(
				(await owner.post('/rest/favorites', { resourceId: 'nope', resourceType: 'workflow' }))
					.status,
			).toBe(404);
			expect(
				(await owner.post('/rest/favorites', { resourceId: 'x', resourceType: 'bogus' })).status,
			).toBe(400);
			expect((await owner.delete('/rest/favorites/workflow/nope')).status).toBe(404);
		});
	});

	describe('disabled features', () => {
		it.each([
			'/rest/community-packages',
			'/rest/community-node-types',
			'/rest/api-keys',
			'/rest/api-keys/scopes',
			'/rest/workflows/abc/test-runs',
			'/rest/workflows/abc/evaluation-configs',
			'/rest/workflows/abc/eval-versions',
		])('GET %s is an empty list', async (path) => {
			const res = await owner.get(path);
			expect(res.status).toBe(200);
			expect(dataOf(res)).toEqual([]);
		});

		it.each([
			'/rest/ldap/config',
			'/rest/sso/saml/config',
			'/rest/sso/oidc/config',
			'/rest/sso/provisioning/config',
			'/rest/source-control/preferences',
			'/rest/external-secrets/providers',
			'/rest/secret-providers/types',
			'/rest/eventbus/destination',
			'/rest/settings/security',
			'/rest/credential-resolvers',
		])('GET %s answers like an unlicensed feature', async (path) => {
			const res = await owner.get(path);
			expect(res.status).toBe(403);
			expect(res.body).toEqual({ status: 'error', message: 'Plan lacks license for this feature' });
		});

		it.each(['/rest/mfa/qr', '/rest/mfa/enable', '/rest/mfa/can-enable'])(
			'%s is unavailable',
			async (path) => {
				const res = path.endsWith('qr') ? await owner.get(path) : await owner.post(path, {});
				expect(res.status).toBe(400);
			},
		);

		it('returns null values for the instance version history', async () => {
			expect(dataOf(await owner.get('/rest/instance-version-history/first-adoption'))).toEqual({
				date: null,
			});
		});

		it('keeps module routes off', async () => {
			expect((await owner.get('/rest/insights/summary')).status).toBe(404);
			expect((await owner.get('/rest/chat/conversations')).status).toBe(404);
		});
	});
});
