import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Instance, Session } from '../api/harness';
import { startInstance } from '../api/harness';
import { startFakeLlm } from './fake-llm';
import { connect, createCredential, failureOf, LC, runWorkflow } from './run';

const manual = {
	name: 'Manual',
	type: 'n8n-nodes-base.manualTrigger',
	typeVersion: 1,
	parameters: {},
};

describe('AI chains and vector stores', () => {
	let instance: Instance;
	let session: Session;
	let llm: Awaited<ReturnType<typeof startFakeLlm>>;
	let credentials: Record<string, { id: string; name: string }>;
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

	it('runs a Basic LLM Chain with a Structured Output Parser', async () => {
		const result = await runWorkflow(
			session,
			[
				manual,
				{
					name: 'Chain',
					type: `${LC}chainLlm`,
					typeVersion: 1.7,
					parameters: { promptType: 'define', text: 'Say hi as JSON', hasOutputParser: true },
				},
				{
					name: 'Model',
					type: `${LC}lmChatOpenAi`,
					typeVersion: 1.2,
					parameters: { model: { __rl: true, mode: 'list', value: 'gpt-test' }, options: {} },
					credentials,
				},
				{
					name: 'Parser',
					type: `${LC}outputParserStructured`,
					typeVersion: 1.3,
					parameters: { schemaType: 'fromJson', jsonSchemaExample: '{"answer":"string"}' },
				},
			],
			connect([
				['Manual', 'Chain'],
				['Model', 'Chain', 'ai_languageModel'],
				['Parser', 'Chain', 'ai_outputParser'],
			]),
		);

		expect(result.status, failureOf(result)).toBe('success');
		expect(result.output('Chain')).toEqual({ output: { answer: 'hi' } });
	});

	it('inserts documents into the in-memory vector store and retrieves them by similarity', async () => {
		const text =
			'Cloudflare Workers run n8n now. Another sentence about vector stores and embeddings.';
		const embeddings = {
			type: `${LC}embeddingsOpenAi`,
			typeVersion: 1.2,
			parameters: { model: 'text-embedding-test', options: {} },
			credentials,
		};
		const memoryKey = { __rl: true, mode: 'list', value: 'ai-test-store' };
		const result = await runWorkflow(
			session,
			[
				manual,
				{
					name: 'Set',
					type: 'n8n-nodes-base.set',
					typeVersion: 3.4,
					parameters: {
						mode: 'manual',
						assignments: { assignments: [{ id: 'a', name: 'text', value: text, type: 'string' }] },
						options: {},
					},
				},
				{
					name: 'Insert',
					type: `${LC}vectorStoreInMemory`,
					typeVersion: 1.3,
					parameters: { mode: 'insert', memoryKey, clearStore: true },
				},
				{ name: 'Insert Embeddings', ...embeddings },
				{
					name: 'Loader',
					type: `${LC}documentDefaultDataLoader`,
					typeVersion: 1.1,
					parameters: {
						dataType: 'json',
						jsonMode: 'expressionData',
						jsonData: '={{ $json.text }}',
						textSplittingMode: 'custom',
						options: {},
					},
				},
				{
					name: 'Splitter',
					type: `${LC}textSplitterRecursiveCharacterTextSplitter`,
					typeVersion: 1,
					parameters: { chunkSize: 40, chunkOverlap: 5, options: {} },
				},
				{
					name: 'Retrieve',
					type: `${LC}vectorStoreInMemory`,
					typeVersion: 1.3,
					parameters: { mode: 'load', memoryKey, prompt: 'vector stores', topK: 2, options: {} },
					executeOnce: true,
				},
				{ name: 'Retrieve Embeddings', ...embeddings },
			],
			connect([
				['Manual', 'Set'],
				['Set', 'Insert'],
				['Insert Embeddings', 'Insert', 'ai_embedding'],
				['Loader', 'Insert', 'ai_document'],
				['Splitter', 'Loader', 'ai_textSplitter'],
				['Insert', 'Retrieve'],
				['Retrieve Embeddings', 'Retrieve', 'ai_embedding'],
			]),
		);

		expect(result.status, failureOf(result)).toBe('success');
		const inserted = result.runData.Insert[0].data?.main?.[0] ?? [];
		expect(inserted.length).toBeGreaterThan(1);
		expect(inserted.map((item) => item.json.pageContent).join(' ')).toContain('vector stores');

		const retrieved = result.runData.Retrieve[0].data?.main?.[0] ?? [];
		expect(retrieved).toHaveLength(2);
		for (const { json } of retrieved) {
			expect(text).toContain(String((json.document as { pageContent: string }).pageContent));
			expect(json.score).toEqual(expect.any(Number));
		}
		const embedded = llm.requests
			.filter((r) => r.path === '/v1/embeddings')
			.map((r) => JSON.stringify(r.body.input));
		expect(embedded.some((input) => input.includes('vector stores'))).toBe(true);
	});
});
