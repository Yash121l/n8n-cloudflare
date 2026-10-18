import { parse } from 'flatted';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Instance, Session } from '../api/harness';
import { dataOf, recordOf, startInstance } from '../api/harness';

interface PushMessage {
	type: string;
	data: Record<string, unknown>;
}

const nodes = [
	{
		id: '1',
		name: 'Manual',
		type: 'n8n-nodes-base.manualTrigger',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	},
	{
		id: '2',
		name: 'Edit Fields',
		type: 'n8n-nodes-base.set',
		typeVersion: 3.4,
		position: [200, 0],
		parameters: {
			assignments: {
				assignments: [
					{
						id: 'a',
						name: 'greeting',
						value: '={{ "hello " + "world".toUpperCase() }}',
						type: 'string',
					},
					{ id: 'b', name: 'n', value: 21, type: 'number' },
				],
			},
			options: {},
		},
	},
	{
		id: '3',
		name: 'Code',
		type: 'n8n-nodes-base.code',
		typeVersion: 2,
		position: [400, 0],
		parameters: {
			jsCode:
				'const out = [];\nfor (const item of $input.all()) {\n  out.push({ json: { ...item.json, doubled: item.json.n * 2, from: $("Edit Fields").first().json.greeting } });\n}\nreturn out;',
		},
	},
	{
		id: '4',
		name: 'Per Item',
		type: 'n8n-nodes-base.code',
		typeVersion: 2,
		position: [600, 0],
		parameters: {
			mode: 'runOnceForEachItem',
			jsCode: 'return { json: { length: $json.greeting.length } };',
		},
	},
];

const connections = {
	Manual: { main: [[{ node: 'Edit Fields', type: 'main', index: 0 }]] },
	'Edit Fields': { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
	Code: { main: [[{ node: 'Per Item', type: 'main', index: 0 }]] },
};

async function openPush(instance: Instance, session: Session, pushRef: string) {
	const url = `${instance.origin.replace(/^http/, 'ws')}/rest/push?pushRef=${pushRef}`;
	const socket = new WebSocket(url, {
		headers: { cookie: session.cookieHeader, origin: instance.origin },
	} as unknown as string[]);
	socket.binaryType = 'arraybuffer';
	const messages: PushMessage[] = [];
	socket.addEventListener('message', (event) => {
		const text =
			typeof event.data === 'string'
				? event.data
				: new TextDecoder().decode(event.data as ArrayBuffer);
		messages.push(JSON.parse(text) as PushMessage);
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve());
		socket.addEventListener('error', () => reject(new Error('push socket failed to open')));
	});
	return { socket, messages };
}

async function waitFor<T>(check: () => T | undefined, timeoutMs = 25_000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const value = check();
		if (value !== undefined) return value;
		if (Date.now() - start > timeoutMs) throw new Error('timed out');
		await new Promise((r) => setTimeout(r, 100));
	}
}

describe('manual execution', () => {
	let instance: Instance;
	let session: Session;
	beforeAll(async () => {
		instance = await startInstance();
		session = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('runs a workflow with expressions and Code nodes and pushes progress', async () => {
		const created = await session.post('/rest/workflows', {
			name: 'Runtime test',
			nodes,
			connections,
			settings: { executionOrder: 'v1' },
		});
		expect(created.status, JSON.stringify(created.body)).toBe(200);
		const workflow = recordOf(dataOf(created));

		const pushRef = 'test-push-ref';
		const { socket, messages } = await openPush(instance, session, pushRef);

		const run = await session.request(
			'POST',
			`/rest/workflows/${String(workflow.id)}/run`,
			{ workflowData: workflow, triggerToStartFrom: { name: 'Manual' } },
			{ 'push-ref': pushRef },
		);
		expect(run.status, JSON.stringify(run.body)).toBe(200);
		const executionId = String(recordOf(dataOf(run)).executionId);

		const finished = await waitFor(() => messages.find((m) => m.type === 'executionFinished'));
		socket.close();
		expect(finished.data).toMatchObject({ executionId, status: 'success' });

		const types = messages.map((m) => m.type);
		expect(types[0]).toBe('executionStarted');
		expect(types).toContain('nodeExecuteBefore');
		expect(types).toContain('nodeExecuteAfterData');
		expect(types.filter((t) => t === 'nodeExecuteAfter')).toHaveLength(4);

		const execution = recordOf(dataOf(await session.get(`/rest/executions/${executionId}`)));
		expect(execution.status).toBe('success');
		expect(execution.mode).toBe('manual');
		const data = parse(String(execution.data)) as {
			resultData: {
				runData: Record<
					string,
					Array<{ data: { main: Array<Array<{ json: Record<string, unknown> }>> } }>
				>;
			};
		};
		const codeOut = data.resultData.runData.Code[0].data.main[0][0].json;
		expect(codeOut).toMatchObject({
			greeting: 'hello WORLD',
			n: 21,
			doubled: 42,
			from: 'hello WORLD',
		});
		const perItem = data.resultData.runData['Per Item'][0].data.main[0][0].json;
		expect(perItem).toEqual({ length: 11 });
	});
});
