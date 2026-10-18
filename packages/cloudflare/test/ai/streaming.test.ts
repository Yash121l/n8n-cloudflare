import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Instance, Session } from '../api/harness';
import { startInstance } from '../api/harness';
import { literal, queryDb } from '../api/sql';
import { startFakeLlm } from './fake-llm';
import type { TestNode } from './run';
import { connect, createCredential, LC, saveWorkflow } from './run';

interface Chunk {
	type: string;
	content?: string;
	metadata?: { nodeName: string; itemIndex: number; runIndex: number; timestamp: number };
}

/** Reads a JSON-lines body and records when each line arrived. */
async function readChunks(response: Response) {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const chunks: Array<Chunk & { receivedAt: number }> = [];
	let buffered = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });
		let newline;
		while ((newline = buffered.indexOf('\n')) !== -1) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			if (line.trim()) chunks.push({ ...(JSON.parse(line) as Chunk), receivedAt: Date.now() });
		}
	}
	expect(buffered).toBe('');
	return chunks;
}

const agent = (text?: string): TestNode => ({
	name: 'AI Agent',
	type: `${LC}agent`,
	typeVersion: 3,
	parameters: text ? { promptType: 'define', text, options: {} } : { options: {} },
});

describe('streaming webhook responses', () => {
	let instance: Instance;
	let session: Session;
	let llm: Awaited<ReturnType<typeof startFakeLlm>>;
	let credentials: Awaited<ReturnType<typeof createCredential>>;
	const model = (name: string): TestNode => ({
		name: 'OpenAI Chat Model',
		type: `${LC}lmChatOpenAi`,
		typeVersion: 1.2,
		parameters: { model: { __rl: true, mode: 'list', value: name }, options: {} },
		credentials,
	});
	const activate = async (nodes: TestNode[], connections: ReturnType<typeof connect>) => {
		const workflow = await saveWorkflow(session, nodes, connections);
		const activated = await session.post(`/rest/workflows/${String(workflow.id)}/activate`, {
			versionId: workflow.versionId,
		});
		expect(activated.status, JSON.stringify(activated.body)).toBe(200);
		return workflow;
	};
	const latestExecution = async (workflowId: unknown) => {
		const deadline = Date.now() + 20_000;
		for (;;) {
			const [execution] = queryDb(
				instance,
				`SELECT status, mode FROM execution_entity WHERE workflowId = ${literal(String(workflowId))} ORDER BY id DESC LIMIT 1`,
			);
			if (execution && !['new', 'running'].includes(String(execution.status))) return execution;
			if (Date.now() > deadline) throw new Error(`no finished execution of ${String(workflowId)}`);
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	};

	beforeAll(async () => {
		llm = await startFakeLlm();
		instance = await startInstance();
		session = await instance.ownerSession();
		credentials = await createCredential(session, 'openAiApi', {
			apiKey: 'sk-test',
			url: `${llm.origin}/v1`,
		});
	});
	afterAll(async () => {
		await instance?.dispose();
		await llm?.close();
	});

	it('streams AI Agent tokens of a Webhook node in streaming mode as JSON lines', async () => {
		const path = `stream-${crypto.randomUUID()}`;
		const workflow = await activate(
			[
				{
					name: 'Webhook',
					type: 'n8n-nodes-base.webhook',
					typeVersion: 2,
					parameters: { path, httpMethod: 'POST', responseMode: 'streaming', options: {} },
					webhookId: crypto.randomUUID(),
				} as TestNode,
				agent('Say something'),
				model('gpt-slow-300'),
			],
			connect([
				['Webhook', 'AI Agent'],
				['OpenAI Chat Model', 'AI Agent', 'ai_languageModel'],
			]),
		);

		const response = await fetch(`${instance.origin}/webhook/${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe('no-cache');
		const chunks = await readChunks(response);
		const finishedAt = Date.now();

		expect(chunks.map((chunk) => chunk.type)).toEqual(['begin', 'item', 'item', 'end']);
		expect(chunks.map((chunk) => chunk.content ?? '').join('')).toBe('plain reply');
		expect(chunks[0].metadata).toMatchObject({ nodeName: 'AI Agent', itemIndex: 0, runIndex: 0 });
		expect(chunks[0].metadata?.timestamp).toEqual(expect.any(Number));
		// The fake model waits 300 ms before each event, so the first token arrives well before the end.
		expect(finishedAt - chunks[1].receivedAt).toBeGreaterThanOrEqual(400);

		const request = llm.requests.findLast((r) => r.path === '/v1/chat/completions');
		expect(request?.body.stream).toBe(true);
		expect(await latestExecution(workflow.id)).toMatchObject({
			status: 'success',
			mode: 'webhook',
		});
	});

	it('serves the hosted chat page and streams the reply of a public Chat Trigger', async () => {
		const webhookId = crypto.randomUUID();
		const workflow = await activate(
			[
				{
					name: 'Chat Trigger',
					type: `${LC}chatTrigger`,
					typeVersion: 1.3,
					parameters: { public: true, mode: 'hostedChat', options: { responseMode: 'streaming' } },
					webhookId,
				} as TestNode,
				agent(),
				model('gpt-test'),
				{ name: 'Calculator', type: `${LC}toolCalculator`, typeVersion: 1, parameters: {} },
			],
			connect([
				['Chat Trigger', 'AI Agent'],
				['OpenAI Chat Model', 'AI Agent', 'ai_languageModel'],
				['Calculator', 'AI Agent', 'ai_tool'],
			]),
		);

		const page = await fetch(`${instance.origin}/webhook/${webhookId}/chat`);
		expect(page.status).toBe(200);
		expect(page.headers.get('content-type')).toContain('text/html');
		// The page keeps its origin, because the widget keeps the session in localStorage.
		expect(page.headers.get('content-security-policy')).toBeNull();
		const html = await page.text();
		expect(html).toContain('@n8n/chat');
		expect(html).toContain(`${instance.origin}/webhook/${webhookId}/chat`);
		expect(html).toMatch(/enableStreaming:\s*true/);

		const response = await fetch(`${instance.origin}/webhook/${webhookId}/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				action: 'sendMessage',
				sessionId: 'session-1',
				chatInput: 'What is 6 times 7?',
			}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
		const chunks = await readChunks(response);
		const types = chunks.map((chunk) => chunk.type);
		// The first agent turn asks for the tool and streams no text. The second turn answers.
		expect(types).toEqual([
			'begin',
			'end',
			'begin',
			...types.slice(3, -1).map(() => 'item'),
			'end',
		]);
		expect(
			chunks
				.slice(3, -1)
				.map((chunk) => chunk.content)
				.join(''),
		).toMatch(/^The answer is .*42/);
		expect(chunks.every((chunk) => chunk.metadata?.nodeName === 'AI Agent')).toBe(true);

		const execution = await latestExecution(workflow.id);
		expect(execution).toMatchObject({ status: 'success', mode: 'webhook' });
		const chats = llm.requests.filter(
			(r) => r.path === '/v1/chat/completions' && r.body.model === 'gpt-test',
		);
		expect(JSON.stringify(chats.at(-2)?.body.messages)).toContain('What is 6 times 7?');
	});

	it('answers a Chat Trigger in lastNode mode with the agent output', async () => {
		const webhookId = crypto.randomUUID();
		await activate(
			[
				{
					name: 'Chat Trigger',
					type: `${LC}chatTrigger`,
					typeVersion: 1.3,
					parameters: { public: true, mode: 'webhook', options: { responseMode: 'lastNode' } },
					webhookId,
				} as TestNode,
				agent(),
				model('gpt-test'),
			],
			connect([
				['Chat Trigger', 'AI Agent'],
				['OpenAI Chat Model', 'AI Agent', 'ai_languageModel'],
			]),
		);
		const response = await fetch(`${instance.origin}/webhook/${webhookId}/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'sendMessage', sessionId: 'session-2', chatInput: 'hello' }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ output: 'plain reply' });
	});

	it('tells a Chat Trigger in responseNodes mode that the run started', async () => {
		const webhookId = crypto.randomUUID();
		const workflow = await activate(
			[
				{
					name: 'Chat Trigger',
					type: `${LC}chatTrigger`,
					typeVersion: 1.4,
					parameters: {
						public: true,
						mode: 'hostedChat',
						options: { responseMode: 'responseNodes' },
					},
					webhookId,
				} as TestNode,
				{ name: 'NoOp', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} },
			],
			connect([['Chat Trigger', 'NoOp']]),
		);
		const response = await fetch(`${instance.origin}/webhook/${webhookId}/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'sendMessage', sessionId: 'session-3', chatInput: 'hi' }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toEqual({
			executionStarted: true,
			executionId: expect.any(String),
			resumeToken: expect.any(String),
		});
		expect(await latestExecution(workflow.id)).toMatchObject({
			status: 'success',
			mode: 'webhook',
		});
	});
});
