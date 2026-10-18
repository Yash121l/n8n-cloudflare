import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, Session, arrayOf, dataOf, recordOf, startInstance } from './harness';

describe('tags', () => {
	let instance: Instance;
	let session: Session;
	beforeAll(async () => {
		instance = await startInstance();
		session = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	const createTag = async (name: string) =>
		recordOf(dataOf(await session.post('/rest/tags', { name })));
	const workflowBody = (name: string, tags?: string[]) => ({
		name,
		nodes: [
			{
				name: 'Manual',
				type: 'n8n-nodes-base.manualTrigger',
				typeVersion: 1,
				position: [0, 0],
				parameters: {},
			},
		],
		connections: {},
		...(tags ? { tags } : {}),
	});

	it('starts empty and creates, renames and deletes tags', async () => {
		expect(dataOf(await session.get('/rest/tags'))).toEqual([]);

		const tag = await createTag('urgent');
		expect(tag).toMatchObject({ name: 'urgent' });
		expect(tag.id).toEqual(expect.any(String));
		expect(tag.createdAt).toEqual(expect.any(String));

		const renamed = recordOf(
			dataOf(await session.patch(`/rest/tags/${String(tag.id)}`, { name: 'important' })),
		);
		expect(renamed).toMatchObject({ id: tag.id, name: 'important' });

		expect(dataOf(await session.delete(`/rest/tags/${String(tag.id)}`))).toBe(true);
		expect(dataOf(await session.get('/rest/tags'))).toEqual([]);
	});

	it('validates names', async () => {
		expect((await session.post('/rest/tags', { name: '' })).status).toBe(400);
		expect((await session.post('/rest/tags', { name: 'x'.repeat(25) })).status).toBe(400);
		await createTag('dup');
		expect((await session.post('/rest/tags', { name: 'dup' })).status).toBe(400);
		const other = await createTag('other');
		expect((await session.patch(`/rest/tags/${String(other.id)}`, { name: 'dup' })).status).toBe(
			400,
		);
		expect((await session.patch('/rest/tags/missing', { name: 'new' })).status).toBe(404);
	});

	it('attaches tags on create and update and returns tag objects', async () => {
		const a = await createTag('alpha');
		const b = await createTag('beta');
		const created = recordOf(
			dataOf(await session.post('/rest/workflows', workflowBody('Tagged', [String(a.id)]))),
		);
		expect(arrayOf(created.tags).map((t) => recordOf(t).name)).toEqual(['alpha']);

		const updated = recordOf(
			dataOf(
				await session.patch(`/rest/workflows/${String(created.id)}`, {
					tags: [String(a.id), String(b.id)],
				}),
			),
		);
		expect(
			arrayOf(updated.tags)
				.map((t) => recordOf(t).name)
				.sort(),
		).toEqual(['alpha', 'beta']);
		expect(updated.versionId).toBe(created.versionId);

		const cleared = recordOf(
			dataOf(await session.patch(`/rest/workflows/${String(created.id)}`, { tags: [] })),
		);
		expect(cleared.tags).toEqual([]);
	});

	it('accepts tag objects and ignores unknown tag ids', async () => {
		const tag = await createTag('objects');
		const created = recordOf(
			dataOf(
				await session.post('/rest/workflows', workflowBody('Objects', undefined) satisfies object),
			),
		);
		const updated = recordOf(
			dataOf(
				await session.patch(`/rest/workflows/${String(created.id)}`, {
					tags: [
						{ id: tag.id, name: 'objects' },
						{ id: 'ghost', name: 'ghost' },
					],
				}),
			),
		);
		expect(arrayOf(updated.tags).map((t) => recordOf(t).name)).toEqual(['objects']);
	});

	it('counts usage without archived workflows and filters the list by tag', async () => {
		const tag = await createTag('counted');
		const live = recordOf(
			dataOf(await session.post('/rest/workflows', workflowBody('Live tagged', [String(tag.id)]))),
		);
		const dead = recordOf(
			dataOf(await session.post('/rest/workflows', workflowBody('Dead tagged', [String(tag.id)]))),
		);
		await session.post(`/rest/workflows/${String(dead.id)}/archive`, {});

		const withUsage = arrayOf(dataOf(await session.get('/rest/tags?withUsageCount=true'))).map(
			recordOf,
		);
		expect(withUsage.find((t) => t.id === tag.id)?.usageCount).toBe(1);
		const plain = arrayOf(dataOf(await session.get('/rest/tags'))).map(recordOf);
		expect(plain.find((t) => t.id === tag.id)).not.toHaveProperty('usageCount');

		const filter = encodeURIComponent(JSON.stringify({ tags: ['counted'], isArchived: false }));
		const list = recordOf((await session.get(`/rest/workflows?filter=${filter}`)).body);
		expect(arrayOf(list.data).map((w) => recordOf(w).id)).toEqual([live.id]);
		const both = encodeURIComponent(JSON.stringify({ tags: ['counted', 'alpha'] }));
		expect(recordOf((await session.get(`/rest/workflows?filter=${both}`)).body).count).toBe(0);
	});

	it('removes taggings when a tag is deleted', async () => {
		const tag = await createTag('temp');
		const workflow = recordOf(
			dataOf(await session.post('/rest/workflows', workflowBody('Loses tag', [String(tag.id)]))),
		);
		await session.delete(`/rest/tags/${String(tag.id)}`);
		const reloaded = recordOf(dataOf(await session.get(`/rest/workflows/${String(workflow.id)}`)));
		expect(reloaded.tags).toEqual([]);
	});
});
