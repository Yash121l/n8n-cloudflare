import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse } from 'flatted';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ENCRYPTION_KEY, Instance, dataOf, recordOf, startInstance } from './harness';
import type { Session } from './harness';
import { insertMember } from './sql';

const BIG_SIZE = 20 * 1024 * 1024;

const manual = {
	id: '1',
	name: 'Manual',
	type: 'n8n-nodes-base.manualTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const download = (id: string, name: string, path: string, url: string) => ({
	id,
	name,
	type: 'n8n-nodes-base.httpRequest',
	typeVersion: 4.2,
	position: [200, Number(id) * 100],
	parameters: {
		url: `${url}${path}`,
		options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
	},
});

const hashNode = {
	id: '4',
	name: 'Hash',
	type: 'n8n-nodes-base.crypto',
	typeVersion: 2,
	position: [400, 200],
	parameters: {
		action: 'hash',
		binaryData: true,
		binaryPropertyName: 'data',
		type: 'SHA256',
		dataPropertyName: 'sha',
		encoding: 'hex',
	},
};

interface RunData {
	resultData: {
		runData: Record<
			string,
			Array<{
				data: {
					main: Array<
						Array<{ json: Record<string, unknown>; binary?: Record<string, { id?: string }> }>
					>;
				};
			}>
		>;
	};
}

async function waitForExecution(session: Session, id: string): Promise<RunData> {
	const deadline = Date.now() + 90_000;
	for (;;) {
		const execution = recordOf(dataOf(await session.get(`/rest/executions/${id}`)));
		if (execution.status === 'success') return parse(String(execution.data)) as RunData;
		if (execution.status === 'error' || execution.status === 'crashed')
			throw new Error(
				`execution ${String(execution.status)}: ${String(execution.data).slice(0, 2000)}`,
			);
		if (Date.now() > deadline) throw new Error('execution timed out');
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

function signedToken(binaryDataId: string): string {
	const secret = createHash('sha256').update(`url-signing:${ENCRYPTION_KEY}`).digest('base64');
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
	const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ id: binaryDataId, exp: Math.floor(Date.now() / 1000) + 600 })}`;
	return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

describe('binary data', () => {
	let instance: Instance;
	let owner: Session;
	let server: Server;
	let big: Buffer;
	let bigId: string;
	let noteId: string;
	let sha: string;

	beforeAll(async () => {
		big = randomBytes(BIG_SIZE);
		server = createServer((req, res) => {
			if (req.url === '/big') {
				res.writeHead(200, {
					'content-type': 'application/octet-stream',
					'content-length': big.length,
				});
				res.end(big);
			} else {
				res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 5 });
				res.end('hello');
			}
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

		instance = await startInstance();
		owner = await instance.ownerSession();
		const created = await owner.post('/rest/workflows', {
			name: 'Binary round trip',
			nodes: [
				manual,
				download('2', 'Big', '/big', url),
				download('3', 'Note', '/note', url),
				hashNode,
			],
			connections: {
				Manual: {
					main: [
						[
							{ node: 'Big', type: 'main', index: 0 },
							{ node: 'Note', type: 'main', index: 0 },
						],
					],
				},
				Big: { main: [[{ node: 'Hash', type: 'main', index: 0 }]] },
			},
			settings: { executionOrder: 'v1' },
		});
		expect(created.status, JSON.stringify(created.body)).toBe(200);
		const workflow = recordOf(dataOf(created));
		const run = await owner.post(`/rest/workflows/${String(workflow.id)}/run`, {
			workflowData: workflow,
			triggerToStartFrom: { name: 'Manual' },
		});
		expect(run.status, JSON.stringify(run.body)).toBe(200);
		const runData = await waitForExecution(owner, String(recordOf(dataOf(run)).executionId));
		bigId = String(runData.resultData.runData.Big[0].data.main[0][0].binary?.data?.id);
		noteId = String(runData.resultData.runData.Note[0].data.main[0][0].binary?.data?.id);
		sha = String(runData.resultData.runData.Hash[0].data.main[0][0].json.sha);
	}, 180_000);

	afterAll(async () => {
		server?.close();
		await instance?.dispose();
	});

	it('stores a 20 MB binary in R2 and hashes it while streaming it back', () => {
		expect(bigId).toMatch(/^s3:workflows\/[^/]+\/executions\/\d+\/binary_data\//);
		expect(sha).toBe(createHash('sha256').update(big).digest('hex'));
	});

	it('downloads the binary with the stored type and name', async () => {
		const res = await instance.worker.fetch(
			`${instance.origin}/rest/binary-data?id=${encodeURIComponent(bigId)}&action=download&fileName=big.bin`,
			{
				headers: { cookie: owner.cookieHeader },
			},
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/octet-stream');
		expect(res.headers.get('content-security-policy')).toMatch(/^sandbox /);
		expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="/);
		const body = Buffer.from(await res.arrayBuffer());
		expect(body.length).toBe(BIG_SIZE);
		expect(createHash('sha256').update(body).digest('hex')).toBe(sha);
	});

	it('views a viewable type inline and refuses one that is not viewable', async () => {
		const view = await owner.request(
			'GET',
			`/rest/binary-data?id=${encodeURIComponent(noteId)}&action=view`,
		);
		expect(view.status).toBe(200);
		expect(view.headers.get('content-type')).toContain('text/plain');
		expect(view.headers.get('content-disposition')).toBeNull();
		expect(view.body).toBe('hello');

		const refused = await owner.get(
			`/rest/binary-data?id=${encodeURIComponent(bigId)}&action=view`,
		);
		expect(refused.status).toBe(400);
	});

	it('hides the binary from users who cannot read its workflow', async () => {
		const stranger = await instance.memberSession(await insertMember(instance, 'stranger'));
		const res = await stranger.get(
			`/rest/binary-data?id=${encodeURIComponent(noteId)}&action=download`,
		);
		expect(res.status).toBe(404);
		expect(
			(
				await instance
					.session()
					.get(`/rest/binary-data?id=${encodeURIComponent(noteId)}&action=download`)
			).status,
		).toBe(401);
	});

	it('rejects malformed ids', async () => {
		const traversal = await owner.get(
			`/rest/binary-data?id=${encodeURIComponent('s3:workflows/1/../2')}&action=download`,
		);
		expect(traversal.status).toBe(400);
		const unknownMode = await owner.get('/rest/binary-data?id=nope:abc&action=download');
		expect(unknownMode.status).toBe(400);
	});

	it('serves a signed link without a session and refuses a bad token', async () => {
		const signed = await instance
			.session()
			.get(`/rest/binary-data/signed?token=${signedToken(noteId)}`);
		expect(signed.status).toBe(200);
		expect(signed.headers.get('content-disposition')).toMatch(/^attachment/);
		expect(signed.body).toBe('hello');

		const bad = await instance.session().get('/rest/binary-data/signed?token=not-a-token');
		expect(bad.status).toBe(400);
	});
});
