import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Instance, Session } from '../api/harness';
import { ENCRYPTION_KEY, dataOf, startInstance } from '../api/harness';
import {
	chain,
	codeNode,
	createWorkflow,
	manualTrigger,
	outputOf,
	runManually,
} from './code-harness';

const probe = `
const seen = {};
try { seen.processType = typeof process; } catch (e) { seen.processType = 'error'; }
try { seen.globalProcess = typeof globalThis.process; } catch (e) { seen.globalProcess = 'error'; }
try { seen.envKey = process.env.N8N_ENCRYPTION_KEY ?? null; } catch (e) { seen.envKey = null; }
try { seen.viaFunction = Function('return process.env.N8N_ENCRYPTION_KEY')(); } catch (e) { seen.viaFunction = null; }
try { seen.viaConstructor = (() => {}).constructor('return process')(); } catch (e) { seen.viaConstructor = null; }
try { seen.viaAsyncConstructor = await (async () => {}).constructor('return process')(); } catch (e) { seen.viaAsyncConstructor = null; }
try { seen.viaProxy = $json.constructor.constructor('return process')(); } catch (e) { seen.viaProxy = null; }
try { seen.viaHelper = this.helpers.httpRequest.constructor('return process')(); } catch (e) { seen.viaHelper = null; }
try { seen.workersEnv = Object.keys((await import('cloudflare:workers')).env); } catch (e) { seen.workersEnv = 'error'; }
try { seen.nodeProcessEnv = Object.keys((await import('node:process')).env); } catch (e) { seen.nodeProcessEnv = 'error'; }
seen.bindings = ['DB', 'STORAGE', 'LOADER', 'RUNNER', 'PUSH', 'EXECUTIONS', 'N8N_ENCRYPTION_KEY'].filter((name) => name in globalThis);
try { await fetch('https://example.com'); seen.fetch = 'reached'; } catch (e) { seen.fetch = 'blocked'; }
try { await fetch('http://127.0.0.1:1/'); seen.localFetch = 'reached'; } catch (e) { seen.localFetch = 'blocked'; }
try { seen.require = typeof require('node:fs').readFileSync; } catch (e) { seen.require = 'blocked'; }
seen.sandbox = typeof navigator === 'object' ? 'isolate' : 'sval';
return [{ json: { result: JSON.stringify(seen) } }];
`;

const pollute = `
Object.prototype.n8nPolluted = 'yes';
Array.prototype.includes = () => true;
JSON.stringify = () => '"replaced"';
JSON.parse = () => ({ replaced: true });
globalThis.n8nLeak = 'yes';
return [{ json: { done: true } }];
`;

const inspect = `
return [{ json: {
	prototype: ({}).n8nPolluted ?? null,
	includes: [].includes(1),
	json: JSON.stringify({ a: 1 }),
	leak: globalThis.n8nLeak ?? null,
} }];
`;

describe('Code node sandbox', () => {
	let instance: Instance;
	let session: Session;
	beforeAll(async () => {
		instance = await startInstance();
		session = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('does not expose the encryption key, host process, bindings or network to user code', async () => {
		const workflow = await createWorkflow(
			session,
			'Sandbox probe',
			[manualTrigger, codeNode('Code', probe)],
			chain('Manual', 'Code'),
		);
		const { status, data } = await runManually(session, workflow);
		expect(status, JSON.stringify(data.resultData.error)).toBe('success');
		const result = String(outputOf(data, 'Code')[0].result);
		expect(result).not.toContain(ENCRYPTION_KEY);
		expect(JSON.parse(result)).toEqual({
			processType: 'undefined',
			globalProcess: 'undefined',
			envKey: null,
			viaFunction: null,
			viaConstructor: null,
			viaAsyncConstructor: null,
			viaProxy: null,
			viaHelper: null,
			workersEnv: [],
			nodeProcessEnv: [],
			bindings: [],
			fetch: 'blocked',
			localFetch: 'blocked',
			require: 'blocked',
			sandbox: 'isolate',
		});
	});

	it('keeps changes to globals and prototypes inside one Code run', async () => {
		const polluter = await createWorkflow(
			session,
			'Polluter',
			[manualTrigger, codeNode('Code', pollute)],
			chain('Manual', 'Code'),
		);
		const polluted = await runManually(session, polluter);
		expect(polluted.status, JSON.stringify(polluted.data.resultData.error)).toBe('success');

		// A later node in the same execution, a later run, and another workflow all start clean.
		const sameRun = await createWorkflow(
			session,
			'Same run',
			[manualTrigger, codeNode('Pollute', pollute), codeNode('Inspect', inspect)],
			chain('Manual', 'Pollute', 'Inspect'),
		);
		const other = await createWorkflow(
			session,
			'Inspector',
			[manualTrigger, codeNode('Inspect', inspect)],
			chain('Manual', 'Inspect'),
		);
		const clean = { prototype: null, includes: false, json: '{"a":1}', leak: null };
		const first = await runManually(session, sameRun);
		expect(first.status, JSON.stringify(first.data.resultData.error)).toBe('success');
		expect(outputOf(first.data, 'Inspect')).toEqual([clean]);
		const second = await runManually(session, other);
		expect(second.status, JSON.stringify(second.data.resultData.error)).toBe('success');
		expect(outputOf(second.data, 'Inspect')).toEqual([clean]);

		// The main isolate still serializes JSON normally.
		expect(dataOf(await session.get(`/rest/workflows/${String(other.id)}`))).toMatchObject({
			name: 'Inspector',
		});
	});
});
