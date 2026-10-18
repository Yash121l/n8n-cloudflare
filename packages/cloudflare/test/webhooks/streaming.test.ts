import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INode } from 'n8n-workflow';
import { startInstance } from '../api/harness';
import type { Instance } from '../api/harness';
import { activate, eventually, executions, node, seed, webhookNode, workflow } from './fixtures';

interface Chunk {
	type: string;
	content?: string;
	metadata: {
		nodeId: string;
		nodeName: string;
		itemIndex: number;
		runIndex: number;
		timestamp: number;
	};
}

const lines = (text: string): Chunk[] =>
	text
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Chunk);

const respond = (body: string): INode =>
	node(
		'Respond',
		'respondToWebhook',
		{ respondWith: 'json', responseBody: body, options: {} },
		1.5,
	);

describe('streaming response mode', () => {
	let instance: Instance;
	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('streams the chunks of Respond to Webhook as JSON lines and ends with the run', async () => {
		await activate(
			instance,
			workflow('stream-respond', [
				webhookNode('stream-respond', 'POST', 'streaming'),
				respond('{"hello":"world"}'),
			]),
		);
		const response = await fetch(`${instance.origin}/webhook/stream-respond`, { method: 'POST' });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe('no-cache');
		expect(response.headers.get('content-encoding')).toBe('identity');
		expect(response.headers.get('content-security-policy')).toMatch(/^sandbox /);
		const chunks = lines(await response.text());
		expect(chunks.map((chunk) => [chunk.type, chunk.content])).toEqual([
			['begin', undefined],
			['item', '{"hello":"world"}'],
			['end', undefined],
		]);
		expect(chunks[1].metadata).toMatchObject({
			nodeId: 'Respond',
			nodeName: 'Respond',
			itemIndex: 0,
			runIndex: 0,
		});
		await eventually(() =>
			expect(executions(instance, 'stream-respond')[0]).toMatchObject({
				mode: 'webhook',
				status: 'success',
			}),
		);
	});

	it('sends an error chunk when a node fails and then ends the stream', async () => {
		await activate(
			instance,
			workflow('stream-error', [
				webhookNode('stream-error', 'POST', 'streaming'),
				node('Fail', 'stopAndError', { errorMessage: 'Stopped on purpose' }),
			]),
		);
		const response = await fetch(`${instance.origin}/webhook/stream-error`, { method: 'POST' });
		expect(response.status).toBe(200);
		const chunks = lines(await response.text());
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({
			type: 'error',
			metadata: { nodeName: 'Fail', itemIndex: 0, runIndex: 0 },
		});
		await eventually(() =>
			expect(executions(instance, 'stream-error')[0]).toMatchObject({
				mode: 'webhook',
				status: 'error',
			}),
		);
	});

	it('streams the test webhook of a manual run', async () => {
		const data = workflow('stream-test', [
			webhookNode('stream-test', 'POST', 'streaming'),
			respond('{"test":true}'),
		]);
		seed(instance, data);
		const registered = await instance.worker.fetch(`${instance.origin}/__test/register`, {
			method: 'POST',
			body: JSON.stringify(data),
		});
		expect(await registered.json()).toEqual({ registered: true });
		const response = await fetch(`${instance.origin}/webhook-test/stream-test`, { method: 'POST' });
		const chunks = lines(await response.text());
		expect(chunks.map((chunk) => chunk.type)).toEqual(['begin', 'item', 'end']);
		expect(chunks[1].content).toBe('{"test":true}');
	});
});
