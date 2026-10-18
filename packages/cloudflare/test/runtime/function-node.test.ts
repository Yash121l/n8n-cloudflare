import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Instance, Session } from '../api/harness';
import { ENCRYPTION_KEY, startInstance } from '../api/harness';
import {
	chain,
	codeNode,
	createWorkflow,
	manualTrigger,
	openPush,
	outputOf,
	runManually,
} from './code-harness';

function functionNode(name: string, functionCode: string, extra: Record<string, unknown> = {}) {
	return {
		id: name,
		name,
		type: 'n8n-nodes-base.function',
		typeVersion: 1,
		position: [400, 0],
		parameters: { functionCode },
		...extra,
	};
}

function functionItemNode(name: string, functionCode: string, extra: Record<string, unknown> = {}) {
	return { ...functionNode(name, functionCode, extra), type: 'n8n-nodes-base.functionItem' };
}

const source = codeNode(
	'Source',
	`return [{ json: { n: 1, name: 'a' } }, { json: { n: 2, name: 'b' } }];`,
);

const probe = `
const seen = {};
try { seen.processType = typeof process; } catch (e) { seen.processType = 'error'; }
try { seen.envKey = process.env.N8N_ENCRYPTION_KEY ?? null; } catch (e) { seen.envKey = null; }
try { seen.viaFunction = Function('return process.env.N8N_ENCRYPTION_KEY')(); } catch (e) { seen.viaFunction = null; }
try { seen.viaConstructor = (() => {}).constructor('return process')(); } catch (e) { seen.viaConstructor = null; }
try { seen.viaProxy = $json.constructor.constructor('return process')(); } catch (e) { seen.viaProxy = null; }
try { seen.viaItem = $item(0).$node.constructor.constructor('return process')(); } catch (e) { seen.viaItem = null; }
try { seen.viaParameter = getNodeParameter.constructor('return process')(); } catch (e) { seen.viaParameter = null; }
try { seen.viaStaticData = getWorkflowStaticData('global').constructor.constructor('return process')(); } catch (e) { seen.viaStaticData = null; }
try { seen.viaHelper = helpers.httpRequest.constructor('return process')(); } catch (e) { seen.viaHelper = null; }
try { seen.workersEnv = Object.keys((await import('cloudflare:workers')).env); } catch (e) { seen.workersEnv = 'error'; }
try { seen.nodeProcessEnv = Object.keys((await import('node:process')).env); } catch (e) { seen.nodeProcessEnv = 'error'; }
seen.bindings = ['DB', 'STORAGE', 'LOADER', 'RUNNER', 'PUSH', 'EXECUTIONS', 'N8N_ENCRYPTION_KEY'].filter((name) => name in globalThis);
try { await fetch('https://example.com'); seen.fetch = 'reached'; } catch (e) { seen.fetch = 'blocked'; }
try { seen.require = typeof require('fs').readFileSync; } catch (e) { seen.require = 'blocked'; }
seen.sandbox = typeof navigator === 'object' ? 'isolate' : 'other';
return [{ json: { result: JSON.stringify(seen) } }];
`;

describe('Function and Function Item nodes', () => {
	let instance: Instance;
	let session: Session;
	beforeAll(async () => {
		instance = await startInstance();
		session = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('runs the Function node with items, $item, the data proxy, static data and console output', async () => {
		const workflow = await createWorkflow(
			session,
			'Function',
			[
				manualTrigger,
				source,
				functionNode(
					'Function',
					`const data = getWorkflowStaticData('global');
data.runs = (data.runs ?? 0) + 1;
for (item of items) {
  item.json.double = item.json.n * 2;
}
console.log('Done!', { count: items.length });
items.push({ json: {
  first: $json.name,
  second: $item(1).$json.name,
  node: $node['Source'].json.n,
  code: getNodeParameter('functionCode', 0).length > 0,
  indexes: items.map((item) => item.index),
  runs: data.runs,
  year: DateTime.fromISO('2026-10-01').year,
  thisHelpers: typeof this.helpers.httpRequest,
} });
return items;`,
				),
			],
			chain('Manual', 'Source', 'Function'),
		);
		const { socket, messages } = await openPush(instance, session, 'function-node');
		const { status, data } = await runManually(session, workflow, 'function-node');
		socket.close();
		expect(status, JSON.stringify(data.resultData.error)).toBe('success');
		expect(outputOf(data, 'Function')).toEqual([
			{ n: 1, name: 'a', double: 2 },
			{ n: 2, name: 'b', double: 4 },
			{
				first: 'a',
				second: 'b',
				node: 1,
				code: true,
				indexes: [0, 1],
				runs: 1,
				year: 2026,
				thisHelpers: 'function',
			},
		]);
		const consoleMessages = messages.filter((message) => message.type === 'sendConsoleMessage');
		expect(consoleMessages.map((message) => message.data)).toEqual([
			{ source: '[Node: "Function"]', messages: ['Done!', { count: 2 }] },
		]);
	});

	it('runs the Function Item node once for each item and reads and writes binary data', async () => {
		const workflow = await createWorkflow(
			session,
			'Function Item',
			[
				manualTrigger,
				source,
				functionItemNode(
					'Function Item',
					`item.double = item.n * 2;
item.previous = $node['Source'].json.name;
item.proxy = $json.name;
await setBinaryDataAsync({ file: { data: Buffer.from('body ' + item.n).toString('base64'), mimeType: 'text/plain', fileName: 'f.txt' } });
return item;`,
				),
				functionNode(
					'Read',
					`const texts = [];
for (const item of items) {
  const binary = await getBinaryDataAsync(item);
  texts.push(Buffer.from(binary.file.data, 'base64').toString());
}
return [{ json: { texts } }];`,
				),
			],
			chain('Manual', 'Source', 'Function Item', 'Read'),
		);
		const { status, data } = await runManually(session, workflow);
		expect(status, JSON.stringify(data.resultData.error)).toBe('success');
		expect(outputOf(data, 'Function Item')).toEqual([
			{ n: 1, name: 'a', double: 2, previous: 'a', proxy: 'a' },
			{ n: 2, name: 'b', double: 4, previous: 'b', proxy: 'b' },
		]);
		expect(data.resultData.runData['Function Item'][0].data?.main[0][1].binary?.file).toMatchObject(
			{ fileName: 'f.txt', mimeType: 'text/plain' },
		);
		expect(outputOf(data, 'Read')).toEqual([{ texts: ['body 1', 'body 2'] }]);
	});

	it('reports errors like the vm2 nodes', async () => {
		const failing = async (node: Record<string, unknown>) => {
			const workflow = await createWorkflow(
				session,
				'Function error',
				[manualTrigger, source, node],
				chain('Manual', 'Source', String(node.name)),
			);
			const { status, data } = await runManually(session, workflow);
			expect(status).toBe('error');
			return data.resultData.error;
		};
		expect(
			await failing(functionNode('Function', 'const value = null;\nreturn value.missing;')),
		).toMatchObject({
			message: "Cannot read properties of null (reading 'missing') [Line 2]",
		});
		expect(await failing(functionNode('Function', 'return [{ json: 1 }];'))).toMatchObject({
			message: 'The json-property has to be an object!',
		});
		expect(
			await failing(
				functionItemNode('Function Item', 'if (item.n === 2) {\n  null.missing;\n}\nreturn item;'),
			),
		).toMatchObject({
			message: "Cannot read properties of null (reading 'missing') [Line 2 | Item Index: 1]",
		});
		expect(await failing(functionItemNode('Function Item', 'return;'))).toMatchObject({
			message: 'No data got returned. Always an object has to be returned!',
		});
		expect(await failing(functionNode('Function', 'const a = 1;\nfoo(;'))).toMatchObject({
			message: "Unexpected token ';' [Line 2]",
		});
	});

	it('continues on fail like the vm2 nodes', async () => {
		const workflow = await createWorkflow(
			session,
			'Function continue',
			[
				manualTrigger,
				source,
				functionNode('Function', 'throw new Error("all failed");', {
					onError: 'continueRegularOutput',
					position: [400, 0],
				}),
				functionItemNode(
					'Function Item',
					'if (item.n === 1) throw new Error("item failed");\nreturn item;',
					{
						onError: 'continueRegularOutput',
					},
				),
			],
			{
				Manual: { main: [[{ node: 'Source', type: 'main', index: 0 }]] },
				Source: {
					main: [
						[
							{ node: 'Function', type: 'main', index: 0 },
							{ node: 'Function Item', type: 'main', index: 0 },
						],
					],
				},
			},
		);
		const { status, data } = await runManually(session, workflow);
		expect(status, JSON.stringify(data.resultData.error)).toBe('success');
		expect(outputOf(data, 'Function')).toEqual([{ error: 'all failed' }]);
		expect(outputOf(data, 'Function Item')).toEqual([
			{ error: 'item failed' },
			{ n: 2, name: 'b' },
		]);
	});

	it('does not expose the encryption key, host process, bindings or network to Function code', async () => {
		const workflow = await createWorkflow(
			session,
			'Function probe',
			[
				manualTrigger,
				source,
				functionNode('Function', probe),
				functionItemNode(
					'Function Item',
					probe.replace(/return \[\{ json: (.*) \}\];/, 'return $1;'),
				),
			],
			{
				Manual: { main: [[{ node: 'Source', type: 'main', index: 0 }]] },
				Source: {
					main: [
						[
							{ node: 'Function', type: 'main', index: 0 },
							{ node: 'Function Item', type: 'main', index: 0 },
						],
					],
				},
			},
		);
		const { status, data } = await runManually(session, workflow);
		expect(status, JSON.stringify(data.resultData.error)).toBe('success');
		const expected = {
			processType: 'undefined',
			envKey: null,
			viaFunction: null,
			viaConstructor: null,
			viaProxy: null,
			viaItem: null,
			viaParameter: null,
			viaStaticData: null,
			viaHelper: null,
			workersEnv: [],
			nodeProcessEnv: [],
			bindings: [],
			fetch: 'blocked',
			require: 'blocked',
			sandbox: 'isolate',
		};
		for (const output of [...outputOf(data, 'Function'), ...outputOf(data, 'Function Item')]) {
			const result = String(output.result);
			expect(result).not.toContain(ENCRYPTION_KEY);
			expect(JSON.parse(result)).toEqual(expected);
		}
		expect(outputOf(data, 'Function Item')).toHaveLength(2);
	});
});
