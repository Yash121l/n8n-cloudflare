import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, Session, arrayOf, dataOf, recordOf, startInstance } from './harness';
import { queryDb, r2Keys } from './sql';

const trigger = {
	name: 'Manual',
	type: 'n8n-nodes-base.manualTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};
const setNode = {
	name: 'Set',
	type: 'n8n-nodes-base.set',
	typeVersion: 3,
	position: [200, 0],
	parameters: {},
};
const webhookWorkflow = (path: string) => ({
	nodes: [
		{
			name: 'Webhook',
			type: 'n8n-nodes-base.webhook',
			typeVersion: 2,
			position: [0, 0],
			parameters: { path, httpMethod: 'GET' },
			webhookId: `${path}-id`,
		},
	],
	connections: {},
});

const connections = { Manual: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } };

async function create(session: Session, overrides: Record<string, unknown> = {}) {
	const res = await session.post('/rest/workflows', {
		name: 'Test workflow',
		nodes: [trigger, setNode],
		connections,
		settings: { executionOrder: 'v1' },
		...overrides,
	});
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return recordOf(dataOf(res));
}

const list = async (session: Session, query = '') => {
	const res = await session.get(`/rest/workflows${query}`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	const body = recordOf(res.body);
	return { count: body.count, data: arrayOf(body.data).map(recordOf) };
};

describe('workflows', () => {
	let instance: Instance;
	let session: Session;
	beforeAll(async () => {
		instance = await startInstance();
		session = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('rejects unauthenticated requests', async () => {
		const anon = instance.session();
		expect((await anon.get('/rest/workflows')).status).toBe(401);
		expect((await anon.post('/rest/workflows', {})).status).toBe(401);
		expect((await anon.get('/rest/tags')).status).toBe(401);
	});

	describe('create and read', () => {
		it('creates a workflow with the fields the editor needs', async () => {
			const workflow = await create(session, { name: 'First' });
			expect(workflow.id).toMatch(/^[A-Za-z0-9]{16}$/);
			expect(workflow).toMatchObject({
				name: 'First',
				active: false,
				isArchived: false,
				activeVersionId: null,
				tags: [],
				parentFolder: null,
				sharedWithProjects: [],
			});
			expect(workflow.versionId).toEqual(expect.any(String));
			expect(workflow.checksum).toMatch(/^[0-9a-f]{64}$/);
			expect(workflow.scopes).toEqual(
				expect.arrayContaining(['workflow:read', 'workflow:update', 'workflow:execute']),
			);
			expect(recordOf(workflow.homeProject)).toMatchObject({ type: 'personal' });
			for (const node of arrayOf(workflow.nodes).map(recordOf))
				expect(node.id).toEqual(expect.any(String));
		});

		it('uses the client generated id and refuses a duplicate', async () => {
			const workflow = await create(session, { id: 'abcdef0123456789', name: 'With id' });
			expect(workflow.id).toBe('abcdef0123456789');
			const again = await session.post('/rest/workflows', {
				id: 'abcdef0123456789',
				name: 'X',
				nodes: [],
				connections: {},
			});
			expect(again.status).toBe(400);
		});

		it('validates the payload', async () => {
			const res = await session.post('/rest/workflows', { name: '', nodes: [], connections: {} });
			expect(res.status).toBe(400);
			const noNodes = await session.post('/rest/workflows', { name: 'x', connections: {} });
			expect(noNodes.status).toBe(400);
		});

		it('returns the same data on GET /workflows/:id', async () => {
			const created = await create(session, { name: 'Round trip' });
			const res = await session.get(`/rest/workflows/${String(created.id)}`);
			expect(res.status).toBe(200);
			expect(dataOf(res)).toEqual(created);
		});

		it('answers 404 for an unknown workflow and reports existence', async () => {
			expect((await session.get('/rest/workflows/doesnotexist')).status).toBe(404);
			const created = await create(session);
			expect(dataOf(await session.get(`/rest/workflows/${String(created.id)}/exists`))).toEqual({
				exists: true,
			});
			expect(dataOf(await session.get('/rest/workflows/doesnotexist/exists'))).toEqual({
				exists: false,
			});
		});

		it('suggests unique names', async () => {
			await create(session, { name: 'Unique name' });
			const res = await session.get('/rest/workflows/new?name=Unique%20name');
			expect(dataOf(res)).toEqual({ name: 'Unique name 2' });
			expect(dataOf(await session.get('/rest/workflows/new'))).toMatchObject({
				name: expect.stringContaining('My workflow'),
			});
		});

		it('answers the canvas boot calls', async () => {
			const created = await create(session);
			const id = String(created.id);
			expect(
				dataOf(await session.get(`/rest/workflows/${id}/collaboration/write-lock`)),
			).toBeNull();
			expect(
				dataOf(await session.get(`/rest/workflows/${id}/executions/last-successful`)),
			).toBeNull();
			expect(dataOf(await session.get('/rest/active-workflows'))).toEqual([]);
			expect((await session.get(`/rest/workflows/${id}/publication-status`)).status).toBe(404);
			expect(dataOf(await session.delete(`/rest/test-webhook/${id}`))).toBe(true);
		});
	});

	describe('list', () => {
		let a: Record<string, unknown>;
		beforeAll(async () => {
			await create(session, { name: 'Alpha list' });
			await create(session, { name: 'beta list', description: 'second one' });
			a = await create(session, { name: 'Gamma list' });
		});

		it('returns the raw { count, data } shape with scopes and ownership', async () => {
			const { count, data } = await list(session, '?includeScopes=true&take=100');
			expect(count).toEqual(expect.any(Number));
			const item = data.find((w) => w.id === a.id);
			expect(item).toBeDefined();
			expect(item?.scopes).toEqual(expect.arrayContaining(['workflow:update']));
			expect(recordOf(item?.homeProject).type).toBe('personal');
			expect(item).not.toHaveProperty('nodes');
		});

		it('filters by name search, case-insensitively', async () => {
			const filter = encodeURIComponent(JSON.stringify({ query: 'ALPHA list' }));
			const { count, data } = await list(session, `?filter=${filter}`);
			expect(data.map((w) => w.name)).toEqual(['Alpha list']);
			expect(count).toBe(1);
		});

		it('searches the description', async () => {
			const filter = encodeURIComponent(JSON.stringify({ query: 'second' }));
			expect((await list(session, `?filter=${filter}`)).data.map((w) => w.name)).toEqual([
				'beta list',
			]);
		});

		it('sorts by name and paginates', async () => {
			const filter = encodeURIComponent(JSON.stringify({ query: 'list' }));
			const sorted = await list(session, `?filter=${filter}&sortBy=name:asc`);
			expect(sorted.data.map((w) => w.name)).toEqual(['Alpha list', 'beta list', 'Gamma list']);
			const desc = await list(session, `?filter=${filter}&sortBy=name:desc`);
			expect(desc.data.map((w) => w.name)).toEqual(['Gamma list', 'beta list', 'Alpha list']);
			const page = await list(session, `?filter=${filter}&sortBy=name:asc&skip=1&take=1`);
			expect(page.count).toBe(3);
			expect(page.data.map((w) => w.name)).toEqual(['beta list']);
		});

		it('honours select and rejects bad parameters', async () => {
			const select = encodeURIComponent(JSON.stringify(['name', 'nodes']));
			const filter = encodeURIComponent(JSON.stringify({ query: 'Gamma list' }));
			const { data } = await list(session, `?filter=${filter}&select=${select}`);
			expect(Object.keys(data[0]).sort()).toEqual(['id', 'name', 'nodes']);
			expect((await session.get('/rest/workflows?sortBy=bogus:asc')).status).toBe(400);
			expect((await session.get('/rest/workflows?skip=1')).status).toBe(400);
			expect(
				(await session.get(`/rest/workflows?select=${encodeURIComponent('["nope"]')}`)).status,
			).toBe(400);
		});

		it('filters by project and archive state', async () => {
			const personal = recordOf(dataOf(await session.get('/rest/projects/personal')));
			const inProject = encodeURIComponent(
				JSON.stringify({ projectId: personal.id, query: 'Alpha list' }),
			);
			expect((await list(session, `?filter=${inProject}`)).data).toHaveLength(1);
			const otherProject = encodeURIComponent(
				JSON.stringify({ projectId: 'nope', query: 'Alpha list' }),
			);
			expect((await list(session, `?filter=${otherProject}`)).data).toHaveLength(0);
			const archived = encodeURIComponent(
				JSON.stringify({ isArchived: true, query: 'Alpha list' }),
			);
			expect((await list(session, `?filter=${archived}`)).data).toHaveLength(0);
		});
	});

	describe('update', () => {
		it('renames without a new version and returns a new checksum', async () => {
			const created = await create(session, { name: 'Before' });
			const res = await session.patch(`/rest/workflows/${String(created.id)}`, { name: 'After' });
			expect(res.status).toBe(200);
			const updated = recordOf(dataOf(res));
			expect(updated.name).toBe('After');
			expect(updated.versionId).toBe(created.versionId);
			expect(updated.checksum).toMatch(/^[0-9a-f]{64}$/);
			expect(updated.checksum).not.toBe(created.checksum);
			expect(updated.scopes).toEqual(expect.arrayContaining(['workflow:update']));
		});

		it('creates a history version when nodes change', async () => {
			const created = await create(session);
			const id = String(created.id);
			const res = await session.patch(`/rest/workflows/${id}`, {
				nodes: [trigger],
				connections: {},
				autosaved: true,
			});
			const updated = recordOf(dataOf(res));
			expect(updated.versionId).not.toBe(created.versionId);

			const history = arrayOf(
				dataOf(await session.get(`/rest/workflow-history/workflow/${id}?take=10`)),
			).map(recordOf);
			expect(history.map((h) => h.versionId)).toEqual(
				expect.arrayContaining([created.versionId, updated.versionId]),
			);
			expect(history.find((h) => h.versionId === updated.versionId)).toMatchObject({
				authors: 'Ada Lovelace',
				autosaved: true,
			});

			const version = recordOf(
				dataOf(
					await session.get(
						`/rest/workflow-history/workflow/${id}/version/${String(created.versionId)}`,
					),
				),
			);
			expect(arrayOf(version.nodes)).toHaveLength(2);
			expect(version.workflowId).toBe(id);
		});

		it('merges partial settings', async () => {
			const created = await create(session, {
				settings: { executionOrder: 'v1', timezone: 'Europe/Paris' },
			});
			const res = await session.patch(`/rest/workflows/${String(created.id)}`, {
				settings: { saveManualExecutions: false },
			});
			expect(recordOf(dataOf(res)).settings).toEqual({
				executionOrder: 'v1',
				timezone: 'Europe/Paris',
				saveManualExecutions: false,
			});
		});

		it('rejects a stale expectedChecksum with 409 unless forceSave is set', async () => {
			const created = await create(session);
			const id = String(created.id);
			const first = recordOf(
				dataOf(
					await session.patch(`/rest/workflows/${id}`, {
						name: 'Edit 1',
						expectedChecksum: created.checksum,
					}),
				),
			);
			const stale = await session.patch(`/rest/workflows/${id}`, {
				name: 'Edit 2',
				expectedChecksum: created.checksum,
			});
			expect(stale.status).toBe(409);
			expect(recordOf(stale.body).message).toContain('someone else');
			const forced = await session.patch(`/rest/workflows/${id}?forceSave=true`, {
				name: 'Edit 2',
				expectedChecksum: created.checksum,
			});
			expect(forced.status).toBe(200);
			const fresh = await session.patch(`/rest/workflows/${id}`, {
				name: 'Edit 3',
				expectedChecksum: recordOf(dataOf(forced)).checksum,
			});
			expect(fresh.status).toBe(200);
			expect(first.checksum).not.toBe(recordOf(dataOf(forced)).checksum);
		});

		it('lets exactly one of several parallel saves from the same state win', async () => {
			const created = await create(session);
			const id = String(created.id);
			const saves = ['one', 'two', 'three', 'four', 'five'].map((name) =>
				session.patch(`/rest/workflows/${id}`, {
					name,
					nodes: [trigger, { ...setNode, name: `Set ${name}` }],
					connections: {},
					expectedChecksum: created.checksum,
				}),
			);
			const results = await Promise.all(saves);
			expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);

			const winner = recordOf(dataOf(results.find((r) => r.status === 200) ?? results[0]));
			const stored = recordOf(dataOf(await session.get(`/rest/workflows/${id}`)));
			expect(stored.name).toBe(winner.name);
			expect(stored.versionId).toBe(winner.versionId);
			const history = queryDb(
				instance,
				`SELECT versionId FROM workflow_history WHERE workflowId = '${id}'`,
			);
			expect(history.map((h) => h.versionId).sort()).toEqual(
				[created.versionId, winner.versionId].sort(),
			);
		});

		it('rejects a forced save whose row changed after it was read', async () => {
			const created = await create(session);
			const id = String(created.id);
			// forceSave skips the checksum check, so every 409 here comes from the compare-and-swap.
			const results = await Promise.all(
				Array.from({ length: 8 }, (_, index) =>
					session.patch(`/rest/workflows/${id}?forceSave=true`, {
						name: `forced ${index}`,
						nodes: [trigger, { ...setNode, name: `Set ${index}` }],
						connections: {},
					}),
				),
			);
			const statuses = results.map((r) => r.status);
			expect(statuses.filter((status) => status !== 200 && status !== 409)).toEqual([]);
			expect(statuses).toContain(409);
			const winners = results.filter((r) => r.status === 200).map((r) => recordOf(dataOf(r)));
			expect(winners.length).toBeGreaterThan(0);
			// Only applied saves wrote history, and the row holds the last applied save.
			const history = queryDb(
				instance,
				`SELECT versionId FROM workflow_history WHERE workflowId = '${id}'`,
			);
			expect(history.map((h) => h.versionId).sort()).toEqual(
				[created.versionId, ...winners.map((winner) => winner.versionId)].sort(),
			);
			const stored = recordOf(dataOf(await session.get(`/rest/workflows/${id}`)));
			expect(winners.map((winner) => winner.versionId)).toContain(stored.versionId);
		});

		it('answers 404 for an unknown workflow', async () => {
			expect((await session.patch('/rest/workflows/nope', { name: 'x' })).status).toBe(404);
		});

		it('refuses to update an archived workflow', async () => {
			const created = await create(session);
			const id = String(created.id);
			await session.post(`/rest/workflows/${id}/archive`, {});
			const res = await session.patch(`/rest/workflows/${id}`, { name: 'No' });
			expect(res.status).toBe(400);
		});
	});

	describe('archive, activate and delete', () => {
		it('archives, unarchives and deletes only archived workflows', async () => {
			const created = await create(session, { name: 'Lifecycle' });
			const id = String(created.id);

			const early = await session.delete(`/rest/workflows/${id}`);
			expect(early.status).toBe(400);

			const archived = recordOf(
				dataOf(
					await session.post(`/rest/workflows/${id}/archive`, {
						expectedChecksum: created.checksum,
					}),
				),
			);
			expect(archived.isArchived).toBe(true);
			expect(archived.versionId).not.toBe(created.versionId);
			expect(archived.checksum).toEqual(expect.any(String));
			expect((await session.post(`/rest/workflows/${id}/archive`, {})).status).toBe(400);

			const restored = recordOf(dataOf(await session.post(`/rest/workflows/${id}/unarchive`, {})));
			expect(restored.isArchived).toBe(false);
			expect((await session.post(`/rest/workflows/${id}/unarchive`, {})).status).toBe(400);

			await session.post(`/rest/workflows/${id}/archive`, {});
			const deleted = await session.delete(`/rest/workflows/${id}`);
			expect(dataOf(deleted)).toBe(true);
			expect((await session.get(`/rest/workflows/${id}`)).status).toBe(404);
		});

		it('deletes the stored data of the executions with the workflow', async () => {
			const created = await create(session, { name: 'With executions' });
			const id = String(created.id);
			const run = await session.post(`/rest/workflows/${id}/run`, {
				workflowData: created,
				triggerToStartFrom: { name: 'Manual' },
			});
			expect(run.status, JSON.stringify(run.body)).toBe(200);
			const executionId = String(recordOf(dataOf(run)).executionId);

			const dataKey = `executions/${executionId}/data.json`;
			for (let i = 0; i < 100 && !r2Keys(instance, dataKey).length; i++)
				await new Promise((r) => setTimeout(r, 200));
			expect(r2Keys(instance, `executions/${executionId}/`)).toContain(dataKey);

			await session.post(`/rest/workflows/${id}/archive`, {});
			expect((await session.delete(`/rest/workflows/${id}`)).status).toBe(200);
			expect(r2Keys(instance, `executions/${executionId}/`)).toEqual([]);
			expect(
				queryDb(instance, `SELECT id FROM execution_entity WHERE workflowId = '${id}'`),
			).toEqual([]);
		});

		it('activates and deactivates, returning activeVersion and a checksum', async () => {
			const created = await create(session, {
				name: 'Activation',
				...webhookWorkflow('activation'),
			});
			const id = String(created.id);

			const activated = recordOf(
				dataOf(
					await session.post(`/rest/workflows/${id}/activate`, {
						versionId: created.versionId,
						expectedChecksum: created.checksum,
					}),
				),
			);
			expect(activated.active).toBe(true);
			expect(activated.activeVersionId).toBe(created.versionId);
			expect(recordOf(activated.activeVersion).versionId).toBe(created.versionId);
			expect(activated.checksum).not.toBe(created.checksum);
			expect(dataOf(await session.get('/rest/active-workflows'))).toContain(id);

			const history = arrayOf(
				dataOf(await session.get(`/rest/workflow-history/workflow/${id}`)),
			).map(recordOf);
			expect(arrayOf(history[0].workflowPublishHistory).map(recordOf)[0]).toMatchObject({
				event: 'activated',
			});

			const deactivated = recordOf(
				dataOf(
					await session.post(`/rest/workflows/${id}/deactivate`, {
						expectedChecksum: activated.checksum,
					}),
				),
			);
			expect(deactivated.active).toBe(false);
			expect(deactivated.activeVersionId).toBeNull();
			expect(deactivated.activeVersion).toBeNull();
			expect(deactivated.checksum).toEqual(expect.any(String));

			const timeline = arrayOf(
				dataOf(
					await session.get(
						`/rest/workflow-history/workflow/${id}/publish-timeline?take=10&skip=0`,
					),
				),
			).map(recordOf);
			expect(timeline.map((e) => e.event)).toEqual(['deactivated', 'activated']);
			expect(timeline[0].user).toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
		});

		it('refuses to activate an unknown version or an archived workflow', async () => {
			const created = await create(session);
			const id = String(created.id);
			expect(
				(await session.post(`/rest/workflows/${id}/activate`, { versionId: 'missing' })).status,
			).toBe(404);
			const archived = recordOf(dataOf(await session.post(`/rest/workflows/${id}/archive`, {})));
			expect(
				(await session.post(`/rest/workflows/${id}/activate`, { versionId: archived.versionId }))
					.status,
			).toBe(400);
		});

		it('archiving an active workflow deactivates it', async () => {
			const created = await create(session, webhookWorkflow('archive-active'));
			const id = String(created.id);
			await session.post(`/rest/workflows/${id}/activate`, { versionId: created.versionId });
			const archived = recordOf(dataOf(await session.post(`/rest/workflows/${id}/archive`, {})));
			expect(archived.active).toBe(false);
			expect(archived.activeVersionId).toBeNull();
		});

		it('names a version while activating and updates its metadata', async () => {
			const created = await create(session, webhookWorkflow('named-version'));
			const id = String(created.id);
			await session.post(`/rest/workflows/${id}/activate`, {
				versionId: created.versionId,
				name: 'v1',
				description: 'first',
			});
			const version = recordOf(
				dataOf(
					await session.get(
						`/rest/workflow-history/workflow/${id}/version/${String(created.versionId)}`,
					),
				),
			);
			expect(version).toMatchObject({ name: 'v1', description: 'first' });
			const patch = await session.patch(
				`/rest/workflow-history/workflow/${id}/versions/${String(created.versionId)}`,
				{ name: 'renamed' },
			);
			expect(patch.status).toBe(200);
			const batch = recordOf(
				dataOf(
					await session.post(`/rest/workflow-history/workflow/${id}/versions`, {
						versionIds: [created.versionId, 'x'],
					}),
				),
			);
			expect(arrayOf(batch.versions)).toHaveLength(1);
		});
	});

	describe('manual run', () => {
		it('validates the body and checks the workflow exists', async () => {
			const created = await create(session);
			const id = String(created.id);
			expect((await session.post(`/rest/workflows/${id}/run`, {})).status).toBe(400);
			expect(
				(
					await session.post('/rest/workflows/nope/run', {
						destinationNode: { nodeName: 'Set', mode: 'inclusive' },
					})
				).status,
			).toBe(404);
		});

		it.todo(
			'starts an execution and returns { executionId } (needs the Workflows binding in the test worker)',
		);
	});

	describe('folders', () => {
		it('creates, lists, renames, moves and deletes folders', async () => {
			const project = recordOf(dataOf(await session.get('/rest/projects/personal')));
			const base = `/rest/projects/${String(project.id)}/folders`;

			const parent = recordOf(dataOf(await session.post(base, { name: 'Parent' })));
			expect(parent).toMatchObject({
				name: 'Parent',
				parentFolder: null,
				workflowCount: 0,
				subFolderCount: 0,
			});
			const child = recordOf(
				dataOf(await session.post(base, { name: 'Child', parentFolderId: parent.id })),
			);
			expect(recordOf(child.parentFolder)).toMatchObject({ id: parent.id, name: 'Parent' });

			const inFolder = await create(session, { name: 'In folder', parentFolderId: parent.id });
			expect(recordOf(inFolder.parentFolder)).toMatchObject({ id: parent.id });

			expect(dataOf(await session.get(`${base}/${String(child.id)}/tree`))).toEqual([
				{
					id: parent.id,
					name: 'Parent',
					children: [{ id: child.id, name: 'Child', children: [] }],
				},
			]);
			expect(dataOf(await session.get(`${base}/${String(parent.id)}/content`))).toEqual({
				totalSubFolders: 1,
				totalWorkflows: 1,
			});

			const folderList = recordOf(
				(await session.get(`${base}?take=10&select=${encodeURIComponent('["path"]')}`)).body,
			);
			expect(folderList.count).toBe(2);
			const paths = arrayOf(folderList.data).map((f) => recordOf(f).path);
			expect(paths).toEqual(expect.arrayContaining([['Parent'], ['Parent', 'Child']]));
			const excluded = encodeURIComponent(
				JSON.stringify({ excludeFolderIdAndDescendants: parent.id }),
			);
			expect(recordOf((await session.get(`${base}?filter=${excluded}`)).body).count).toBe(0);

			const overview = encodeURIComponent(
				JSON.stringify({ projectId: project.id, parentFolderId: '0', query: 'Parent' }),
			);
			const { data } = await list(
				session,
				`?includeFolders=true&includeScopes=true&filter=${overview}&sortBy=name:asc`,
			);
			expect(data[0]).toMatchObject({
				resource: 'folder',
				name: 'Parent',
				workflowCount: 1,
				subFolderCount: 1,
			});

			const inside = encodeURIComponent(
				JSON.stringify({ projectId: project.id, parentFolderId: parent.id }),
			);
			const contents = await list(session, `?includeFolders=true&filter=${inside}`);
			expect(contents.data.map((i) => [i.resource, i.name])).toEqual([
				['folder', 'Child'],
				['workflow', 'In folder'],
			]);
			expect(contents.count).toBe(2);

			expect(
				(await session.patch(`${base}/${String(parent.id)}`, { name: 'Renamed' })).status,
			).toBe(200);
			const cycle = await session.patch(`${base}/${String(parent.id)}`, {
				parentFolderId: child.id,
			});
			expect(cycle.status).toBe(400);

			const deleted = await session.delete(`${base}/${String(parent.id)}?transferToFolderId=0`);
			expect(deleted.status).toBe(200);
			const moved = recordOf(dataOf(await session.get(`/rest/workflows/${String(inFolder.id)}`)));
			expect(moved.parentFolder).toBeNull();
			expect((await session.get(`${base}/${String(parent.id)}/content`)).status).toBe(404);
		});

		it('archives the contents when a folder is deleted without a transfer target', async () => {
			const project = recordOf(dataOf(await session.get('/rest/projects/personal')));
			const base = `/rest/projects/${String(project.id)}/folders`;
			const folder = recordOf(dataOf(await session.post(base, { name: 'Doomed' })));
			const inside = await create(session, { name: 'Inside doomed', parentFolderId: folder.id });
			expect((await session.delete(`${base}/${String(folder.id)}`)).status).toBe(200);
			const after = recordOf(dataOf(await session.get(`/rest/workflows/${String(inside.id)}`)));
			expect(after).toMatchObject({ isArchived: true, parentFolder: null });
		});

		it('rejects a missing parent folder', async () => {
			const res = await session.post('/rest/workflows', {
				name: 'x',
				nodes: [],
				connections: {},
				parentFolderId: 'missing',
			});
			expect(res.status).toBe(404);
		});
	});

	describe('side endpoints', () => {
		it('returns empty dependency counts per requested id', async () => {
			const res = await session.post('/rest/workflow-dependencies/counts', {
				resourceIds: ['a'],
				resourceType: 'workflow',
			});
			expect(recordOf(recordOf(dataOf(res)).a)).toMatchObject({ workflowCall: 0, credentialId: 0 });
		});

		it('lists workflows containing a node type', async () => {
			await create(session, { name: 'Has set node' });
			const res = await session.post('/rest/workflows/with-node-types', {
				nodeTypes: ['n8n-nodes-base.set'],
			});
			const body = recordOf(res.body);
			expect(body.count).toBeGreaterThan(0);
			expect(recordOf(arrayOf(body.data)[0]).resourceType).toBe('workflow');
		});
	});
});
