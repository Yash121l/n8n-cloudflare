import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, dataOf, recordOf, startInstance } from '../api/harness';
import type { Session } from '../api/harness';

describe('declarative load options', () => {
	let instance: Instance;
	let owner: Session;
	let server: Server;
	let credentialId: string;
	const seen: Array<{ url: string | undefined; authorization: string | undefined }> = [];

	beforeAll(async () => {
		server = createServer((req: IncomingMessage, res) => {
			seen.push({ url: req.url, authorization: req.headers.authorization });
			res
				.writeHead(200, { 'content-type': 'application/json' })
				.end(JSON.stringify({ data: [{ id: 'dall-e-3' }, { id: 'gpt-4' }, { id: 'dall-e-2' }] }));
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

		instance = await startInstance();
		owner = await instance.ownerSession();
		const created = await owner.post('/rest/credentials', {
			name: 'OpenAI',
			type: 'openAiApi',
			data: { apiKey: 'sk-test', url: `${origin}/v1` },
		});
		expect(created.status, JSON.stringify(created.body)).toBe(200);
		credentialId = String(recordOf(dataOf(created)).id);
	}, 120_000);

	afterAll(async () => {
		server?.close();
		await instance?.dispose();
	});

	const options = (body: Record<string, unknown>) =>
		owner.post('/rest/dynamic-node-parameters/options', {
			nodeTypeAndVersion: { name: 'n8n-nodes-base.openAi', version: 1.1 },
			path: 'parameters.imageModel',
			currentNodeParameters: { resource: 'image', operation: 'create' },
			credentials: { openAiApi: { id: credentialId, name: 'OpenAI' } },
			...body,
		});

	it('runs the routing of the property at the path, with the credential', async () => {
		const res = await options({ loadOptions: {} });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(dataOf(res)).toEqual([
			{ name: 'dall-e-2', value: 'dall-e-2' },
			{ name: 'dall-e-3', value: 'dall-e-3' },
		]);
		expect(seen.at(-1)).toEqual({ url: '/v1/models', authorization: 'Bearer sk-test' });
	});

	it('ignores a routing that the request body carries', async () => {
		const before = seen.length;
		const res = await options({
			loadOptions: { routing: { request: { method: 'GET', url: '/evil' } } },
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(seen.slice(before).map((r) => r.url)).toEqual(['/v1/models']);
	});

	it('refuses a path that has no loadOptions routing', async () => {
		const res = await options({ path: 'parameters.resource', loadOptions: {} });
		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({
			message: expect.stringContaining('has no loadOptions routing'),
		});
	});

	it('answers an empty list when the request names neither a method nor loadOptions', async () => {
		const res = await options({});
		expect(dataOf(res)).toEqual([]);
	});
});
