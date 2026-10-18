import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Instance, Session } from '../api/harness';
import { recordOf, startInstance } from '../api/harness';
import {
	chain,
	codeNode,
	createWorkflow,
	manualTrigger,
	openPush,
	outputOf,
	runManually,
} from './code-harness';

const editFields = {
	id: 'set',
	name: 'Edit Fields',
	type: 'n8n-nodes-base.set',
	typeVersion: 3.4,
	position: [100, 0],
	parameters: {
		assignments: {
			assignments: [
				{ id: 'a', name: 'greeting', value: 'hello', type: 'string' },
				{ id: 'b', name: 'n', value: 21, type: 'number' },
			],
		},
		options: {},
	},
};

describe('Code node parity with the task runner', () => {
	let instance: Instance;
	let session: Session;
	let server: Server;
	let serverUrl: string;
	const requests: string[] = [];
	beforeAll(async () => {
		server = createServer((request, response) => {
			requests.push(`${request.method} ${request.url}`);
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ value: 'from server' }));
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		instance = await startInstance();
		session = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
		server?.close();
	});

	it('runs both modes with the data proxy, helpers, binary data, custom data and editor logs', async () => {
		const workflow = await createWorkflow(
			session,
			'Code parity',
			[
				manualTrigger,
				editFields,
				codeNode(
					'All Items',
					`const response = await this.helpers.httpRequest({ url: '${serverUrl}/data', json: true });
$execution.customData.set('source', 'code');
console.log('items', $input.all().length, { first: $json.greeting });
const file = await this.helpers.prepareBinaryData(Buffer.from('file body'), 'file.txt', 'text/plain');
return $input.all().map((item) => ({
	json: { ...item.json, fromServer: response.value, first: $('Edit Fields').first().json.greeting, custom: $execution.customData.get('source') },
	binary: { file },
}));`,
				),
				codeNode(
					'Each Item',
					`const buffer = await this.helpers.getBinaryDataBuffer($itemIndex, 'file');
return { json: { text: buffer.toString(), n: $json.n, fromServer: $json.fromServer } };`,
					{ parameters: { mode: 'runOnceForEachItem' } },
				),
				codeNode('Fails', 'const x = 1;\nthrow new Error("expected failure");', {
					onError: 'continueRegularOutput',
				}),
			],
			chain('Manual', 'Edit Fields', 'All Items', 'Each Item', 'Fails'),
		);
		const { socket, messages } = await openPush(instance, session, 'code-parity');
		const { status, data } = await runManually(session, workflow, 'code-parity');
		socket.close();

		expect(status, JSON.stringify(data.resultData.error)).toBe('success');
		expect(outputOf(data, 'All Items')).toEqual([
			{ greeting: 'hello', n: 21, fromServer: 'from server', first: 'hello', custom: 'code' },
		]);
		const binary = data.resultData.runData['All Items'][0].data?.main[0][0].binary;
		expect(binary?.file).toMatchObject({ fileName: 'file.txt', mimeType: 'text/plain' });
		expect(outputOf(data, 'Each Item')).toEqual([
			{ text: 'file body', n: 21, fromServer: 'from server' },
		]);
		expect(outputOf(data, 'Fails')).toEqual([{ error: 'expected failure [line 2]' }]);
		expect(data.resultData.metadata).toEqual({ source: 'code' });
		expect(requests).toEqual(['GET /data']);
		const consoleMessages = messages.filter((message) => message.type === 'sendConsoleMessage');
		expect(consoleMessages.map((message) => message.data)).toEqual([
			{ source: '[Node: "All Items"]', messages: ["'items'", 1, { first: 'hello' }] },
		]);
	});

	it('fails the execution with the line of the error when continue on fail is off', async () => {
		const workflow = await createWorkflow(
			session,
			'Code error',
			[
				manualTrigger,
				codeNode('Code', 'const value = null;\nreturn [{ json: { x: value.missing } }];'),
			],
			chain('Manual', 'Code'),
		);
		const { status, data } = await runManually(session, workflow);
		expect(status).toBe('error');
		expect(data.resultData.error).toMatchObject({
			message: "Cannot read properties of null (reading 'missing') [line 2]",
			description: 'TypeError',
		});
	});

	it('keeps workflow static data across production runs of an active workflow', async () => {
		const path = `static-data-${Date.now()}`;
		const workflow = await createWorkflow(
			session,
			'Static data',
			[
				{
					id: 'webhook',
					name: 'Webhook',
					type: 'n8n-nodes-base.webhook',
					typeVersion: 2,
					position: [0, 0],
					webhookId: `${path}-id`,
					parameters: { path, httpMethod: 'GET', responseMode: 'lastNode', options: {} },
				},
				codeNode(
					'Counter',
					`const data = $getWorkflowStaticData('global');
data.count = (data.count ?? 0) + 1;
return [{ json: { count: data.count } }];`,
				),
			],
			chain('Webhook', 'Counter'),
		);
		const activated = await session.post(`/rest/workflows/${String(workflow.id)}/activate`, {
			versionId: workflow.versionId,
		});
		expect(activated.status, JSON.stringify(activated.body)).toBe(200);
		const counts: unknown[] = [];
		for (let i = 0; i < 3; i++) {
			const response = await instance.worker.fetch(`${instance.origin}/webhook/${path}`);
			expect(response.status).toBe(200);
			counts.push(recordOf(await response.json()).count);
		}
		expect(counts).toEqual([1, 2, 3]);
	});
});
