import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Instance, Session } from '../api/harness';
import { startInstance } from '../api/harness';
import { startFakeLlm } from './fake-llm';
import {
	connect,
	createCredential,
	failureOf,
	LC,
	runSavedWorkflow,
	runWorkflow,
	saveWorkflow,
} from './run';

const manual = {
	name: 'Manual',
	type: 'n8n-nodes-base.manualTrigger',
	typeVersion: 1,
	parameters: {},
};
const agent = {
	name: 'AI Agent',
	type: `${LC}agent`,
	typeVersion: 3,
	parameters: { promptType: 'define', text: 'What is 6 times 7? Use the tool.', options: {} },
};

describe('AI agents', () => {
	let instance: Instance;
	let session: Session;
	let llm: Awaited<ReturnType<typeof startFakeLlm>>;
	beforeAll(async () => {
		llm = await startFakeLlm();
		instance = await startInstance();
		session = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
		await llm?.close();
	});

	it('runs an agent with an OpenAI chat model and the Calculator tool', async () => {
		const credentials = await createCredential(session, 'openAiApi', {
			apiKey: 'sk-test',
			url: `${llm.origin}/v1`,
		});
		const result = await runWorkflow(
			session,
			[
				manual,
				agent,
				{
					name: 'OpenAI Chat Model',
					type: `${LC}lmChatOpenAi`,
					typeVersion: 1.2,
					parameters: { model: { __rl: true, mode: 'list', value: 'gpt-test' }, options: {} },
					credentials,
				},
				{ name: 'Calculator', type: `${LC}toolCalculator`, typeVersion: 1, parameters: {} },
			],
			connect([
				['Manual', 'AI Agent'],
				['OpenAI Chat Model', 'AI Agent', 'ai_languageModel'],
				['Calculator', 'AI Agent', 'ai_tool'],
			]),
		);

		expect(result.status, failureOf(result)).toBe('success');
		expect(String(result.output('AI Agent')?.output)).toMatch(/^The answer is .*42/);
		expect(result.runData.Calculator?.length).toBeGreaterThan(0);

		const chats = llm.requests.filter((r) => r.path === '/v1/chat/completions');
		expect(chats.length).toBe(2);
		expect(chats[0].headers.authorization).toBe('Bearer sk-test');
		expect(JSON.stringify(chats[0].body.tools)).toContain('calculator');
		expect(JSON.stringify(chats[1].body.messages)).toContain('42');
	});

	it('runs an agent with a tool variant of a nodes-base node', async () => {
		const credentials = await createCredential(session, 'openAiApi', {
			apiKey: 'sk-test',
			url: `${llm.origin}/v1`,
		});
		const before = llm.requests.length;
		const result = await runWorkflow(
			session,
			[
				manual,
				agent,
				{
					name: 'OpenAI Chat Model',
					type: `${LC}lmChatOpenAi`,
					typeVersion: 1.2,
					parameters: { model: { __rl: true, mode: 'list', value: 'gpt-test' }, options: {} },
					credentials,
				},
				{
					name: 'HTTP Request Tool',
					type: 'n8n-nodes-base.httpRequestTool',
					typeVersion: 4.2,
					parameters: {
						method: 'GET',
						url: `${llm.origin}/v1/models`,
						toolDescription: 'Lists the models',
					},
				},
			],
			connect([
				['Manual', 'AI Agent'],
				['OpenAI Chat Model', 'AI Agent', 'ai_languageModel'],
				['HTTP Request Tool', 'AI Agent', 'ai_tool'],
			]),
		);

		expect(result.status, failureOf(result)).toBe('success');
		expect(String(result.output('AI Agent')?.output)).toContain('fake-1');
		const paths = llm.requests.slice(before).map((r) => r.path);
		expect(paths).toEqual(['/v1/chat/completions', '/v1/models', '/v1/chat/completions']);
	});

	it('runs an agent with an Anthropic chat model, window memory and the Code Tool', async () => {
		const credentials = await createCredential(session, 'anthropicApi', {
			apiKey: 'sk-ant-test',
			url: llm.origin,
		});
		const nodes = [
			manual,
			agent,
			{
				name: 'Anthropic Chat Model',
				type: `${LC}lmChatAnthropic`,
				typeVersion: 1.3,
				parameters: { model: { __rl: true, mode: 'id', value: 'claude-test' }, options: {} },
				credentials,
			},
			{
				name: 'Memory',
				type: `${LC}memoryBufferWindow`,
				typeVersion: 1.3,
				parameters: {
					sessionIdType: 'customKey',
					sessionKey: 'ai-test-session',
					contextWindowLength: 5,
				},
			},
			{
				name: 'Code Tool',
				type: `${LC}toolCode`,
				typeVersion: 1.3,
				parameters: {
					name: 'multiply',
					description: 'Multiplies two numbers written as a*b',
					language: 'javaScript',
					jsCode:
						"const text = typeof query === 'string' ? query : query.input;\nconst [a, b] = text.split('*');\nreturn String(Number(a) * Number(b));",
				},
			},
		];
		const connections = connect([
			['Manual', 'AI Agent'],
			['Anthropic Chat Model', 'AI Agent', 'ai_languageModel'],
			['Memory', 'AI Agent', 'ai_memory'],
			['Code Tool', 'AI Agent', 'ai_tool'],
		]);

		// Window memory is kept for each workflow and session key, so both runs use one saved workflow.
		const workflow = await saveWorkflow(session, nodes, connections);
		const first = await runSavedWorkflow(session, workflow);
		expect(first.status, failureOf(first)).toBe('success');
		expect(String(first.output('AI Agent')?.output)).toMatch(/^Anthropic says: .*42/);

		const messages = llm.requests.filter((r) => r.path === '/v1/messages');
		expect(messages.length).toBe(2);
		expect(messages[0].headers['x-api-key']).toBe('sk-ant-test');
		// Agent v3 names a tool after its node.
		expect(JSON.stringify(messages[0].body.tools)).toContain('Code_Tool');

		// The second run reads the first exchange back from the window memory.
		const second = await runSavedWorkflow(session, workflow);
		expect(second.status, failureOf(second)).toBe('success');
		const history = JSON.stringify(
			llm.requests.filter((r) => r.path === '/v1/messages')[2].body.messages,
		);
		expect(history).toContain('Anthropic says:');
	});
});
