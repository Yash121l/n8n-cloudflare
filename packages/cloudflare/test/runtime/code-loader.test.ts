import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_startWorker as startWorker } from 'wrangler';

interface RunResponse {
	output: { ok: true; result: unknown } | { ok: false; error: Record<string, unknown> };
	logs: string[][];
	helperCalls: string[];
	elapsedMs: number;
	metadata: Record<string, string> | null;
	staticData: Record<string, unknown>;
	staticDataChanged: boolean;
	host: { prototype: boolean; json: string; global: boolean };
}

const root = resolve(import.meta.dirname, '../..');

type Worker = Awaited<ReturnType<typeof startWorker>>;

async function startLoaderWorker(withLoader: boolean): Promise<Worker> {
	const directory = mkdtempSync(join(tmpdir(), 'n8n-code-loader-'));
	const built = spawnSync(
		'node',
		['build.mjs', 'test/runtime/code-loader-worker.ts', join(directory, 'worker')],
		{
			cwd: root,
			encoding: 'utf8',
		},
	);
	if (built.status !== 0) throw new Error(built.stderr);
	writeFileSync(
		join(directory, 'wrangler.jsonc'),
		JSON.stringify({
			name: 'code-loader-test',
			main: join(directory, 'worker/code-loader-worker.js'),
			base_dir: join(directory, 'worker'),
			no_bundle: true,
			find_additional_modules: true,
			rules: [{ type: 'ESModule', globs: ['**/*.js'] }],
			compatibility_date: '2026-10-01',
			compatibility_flags: ['nodejs_compat'],
			...(withLoader ? { worker_loaders: [{ binding: 'LOADER' }] } : {}),
		}),
	);
	const worker = await startWorker({
		config: join(directory, 'wrangler.jsonc'),
		dev: { server: { port: 0 }, inspector: false, logLevel: 'error' },
	});
	await worker.ready;
	return worker;
}

async function runIn(
	worker: Worker,
	code: string,
	options: Record<string, unknown> = {},
	body: Record<string, unknown> = {},
) {
	const response = await worker.fetch('http://localhost/run', {
		method: 'POST',
		body: JSON.stringify({
			settings: {
				code,
				nodeMode: 'runOnceForAllItems',
				workflowMode: 'manual',
				continueOnFail: false,
				...options,
			},
			...body,
		}),
	});
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()) as RunResponse;
}

function resultOf(data: RunResponse) {
	if (!data.output.ok) throw new Error(`Code task failed: ${JSON.stringify(data.output.error)}`);
	return data.output.result;
}

describe('Code node in a Dynamic Worker', () => {
	let worker: Worker;
	beforeAll(async () => {
		worker = await startLoaderWorker(true);
	});
	afterAll(async () => {
		await worker?.dispose();
	});

	const run = async (
		code: string,
		options?: Record<string, unknown>,
		body?: Record<string, unknown>,
	) => await runIn(worker, code, options, body);

	it('measures the latency of one Code task, cold and warm', async () => {
		const cold = await run('return [{ json: { ok: true } }];');
		expect(resultOf(cold)).toEqual([{ json: { ok: true } }]);
		const warm: number[] = [];
		for (let i = 0; i < 10; i++)
			warm.push((await run('return [{ json: { ok: true } }];')).elapsedMs);
		const items = Array.from({ length: 1000 }, (_, n) => ({ json: { n, text: 'x'.repeat(100) } }));
		const large = await run(
			'return $input.all().map((item) => ({ json: { n: item.json.n * 2 } }));',
			{},
			{ items },
		);
		expect(resultOf(large)).toHaveLength(1000);
		warm.sort((a, b) => a - b);
		console.log(
			`Code task latency (ms): cold ${cold.elapsedMs.toFixed(0)}, warm median ${warm[5].toFixed(0)}, ` +
				`warm min ${warm[0].toFixed(0)}, warm max ${warm[9].toFixed(0)}, 1000 items ${large.elapsedMs.toFixed(0)}`,
		);
	});

	it('runs once for all items with the workflow data proxy and sloppy-mode semantics', async () => {
		const data = await run(`
await Promise.resolve();
implicitGlobal = 'sloppy';
return [{ json: {
	count: $input.all().length,
	json: $json.n,
	first: $('Source').first().json.n,
	items: items.length,
	variable: $vars.example,
	year: DateTime.fromISO('2026-10-01').year,
	execution: $execution.id,
	implicitGlobal,
	thisHelpers: typeof this.helpers.httpRequest,
	sandbox: typeof navigator === 'object' ? 'isolate' : 'sval',
} }];`);
		expect(resultOf(data)).toEqual([
			{
				json: {
					count: 2,
					json: 1,
					first: 1,
					items: 2,
					variable: 'variable',
					year: 2026,
					execution: 'execution',
					implicitGlobal: 'sloppy',
					thisHelpers: 'function',
					sandbox: 'isolate',
				},
			},
		]);
	});

	it('runs once for each item, pairs items and continues after item errors', async () => {
		const data = await run(
			'await new Promise((resolve) => setTimeout(resolve, 1));\nif ($json.n === 1) throw new Error("item failed");\nreturn { json: { value: $json.n * 2, index: $itemIndex } };',
			{ nodeMode: 'runOnceForEachItem', continueOnFail: true },
		);
		expect(resultOf(data)).toEqual([
			{ json: { error: 'item failed [line 2]' }, pairedItem: { item: 0 } },
			{ json: { value: 4, index: 1 }, pairedItem: { item: 1 } },
		]);
	});

	it('returns custom data and static data, and reaches helpers and the editor log over RPC', async () => {
		const data = await run(
			`
$execution.customData.set('key', 'value');
const staticData = $getWorkflowStaticData('global');
staticData.count = (staticData.count ?? 0) + 1;
console.log('hello', { count: staticData.count });
const buffer = await this.helpers.getBinaryDataBuffer(0, 'data');
const prepared = await helpers.prepareBinaryData(Buffer.from('made in code'), 'file.txt');
return [{
	json: {
		custom: $execution.customData.get('key'),
		isBuffer: Buffer.isBuffer(buffer),
		binary: buffer.toString(),
		text: await this.helpers.binaryToString(Buffer.from('text')),
	},
	binary: { data: prepared },
}];`,
			{},
			{ staticData: { global: { count: 41 } } },
		);
		expect(resultOf(data)).toEqual([
			{
				json: { custom: 'value', isBuffer: true, binary: 'binary round trip', text: 'text' },
				binary: {
					data: {
						data: Buffer.from('made in code').toString('base64'),
						mimeType: 'text/plain',
						fileName: 'file.txt',
					},
				},
			},
		]);
		expect(data.metadata).toEqual({ key: 'value' });
		expect(data.staticData).toEqual({ global: { count: 42 } });
		expect(data.staticDataChanged).toBe(true);
		expect(data.logs).toEqual([["'hello'", '{"count":42}']]);
		expect(data.helperCalls).toEqual([
			'getBinaryDataBuffer:0:data',
			'prepareBinaryData:true:file.txt',
		]);
	});

	it('leaves static data unchanged when the code does not write it', async () => {
		const data = await run(
			'return [{ json: { count: $getWorkflowStaticData("global").count } }];',
			{},
			{ staticData: { global: { count: 7 } } },
		);
		expect(resultOf(data)).toEqual([{ json: { count: 7 } }]);
		expect(data.staticDataChanged).toBe(false);
	});

	it('applies the custom data limits in the host when user code rewrites the sandbox result', async () => {
		const data = await run(`
Object.defineProperty(Object.prototype, 'toJSON', {
	configurable: true,
	value() {
		if (!('result' in this && 'customData' in this)) return this;
		const customData = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['key' + i, 'x'.repeat(600)]));
		return { result: [{ json: { forged: true } }], customData: { ...customData, 'bad key': 'v', object: { nested: 1 } } };
	},
});
return [];`);
		expect(resultOf(data)).toEqual([{ json: { forged: true } }]);
		expect(Object.keys(data.metadata ?? {})).toHaveLength(10);
		expect(Object.values(data.metadata ?? {}).every((value) => value.length === 512)).toBe(true);
	});

	it('reports errors like the task runner', async () => {
		const thrown = await run('const a = 1;\nnull.missing;');
		expect(thrown.output).toMatchObject({
			ok: false,
			error: {
				message: "Cannot read properties of null (reading 'missing') [line 2]",
				description: 'TypeError',
				lineNumber: 2,
			},
		});
		const syntax = await run('const a = 1;\nfoo(;');
		expect(syntax.output).toMatchObject({
			ok: false,
			error: { message: "Unexpected token ';' [line 2]", description: 'SyntaxError' },
		});
		const object = await run('throw { code: 42 };');
		expect(object.output).toMatchObject({ ok: false, error: { message: '{"code":42}' } });
		const continued = await run('throw new Error("failed");', { continueOnFail: true });
		expect(resultOf(continued)).toEqual([{ json: { error: 'failed [line 1]' } }]);
		const nullResult = await run('return null;');
		expect(resultOf(nullResult)).toEqual([]);
		const runCode = await run('return await Promise.resolve(answer);', {
			nodeMode: 'runCode',
			additionalProperties: { answer: 42 },
		});
		expect(resultOf(runCode)).toBe(42);
	});

	it('gives user code no host process, bindings or network', async () => {
		const data = await run(`
const seen = { process: typeof process, globalProcess: typeof globalThis.process };
try { seen.env = Object.keys((await import('cloudflare:workers')).env); } catch (e) { seen.env = 'error'; }
try { await fetch('https://example.com'); seen.fetch = 'reached'; } catch (e) { seen.fetch = 'blocked'; }
try { const { connect } = await import('cloudflare:sockets'); await connect('example.com:443').opened; seen.tcp = 'reached'; } catch (e) { seen.tcp = 'blocked'; }
try { seen.function = (() => {}).constructor('return typeof process')(); } catch (e) { seen.function = 'blocked'; }
try { seen.require = require('node:fs'); } catch (e) { seen.require = e.message; }
seen.bindings = ['DB', 'STORAGE', 'LOADER', 'RUNNER', 'N8N_ENCRYPTION_KEY'].filter((name) => name in globalThis);
return [{ json: seen }];`);
		expect(resultOf(data)).toEqual([
			{
				json: {
					process: 'undefined',
					globalProcess: 'undefined',
					env: [],
					fetch: 'blocked',
					tcp: 'blocked',
					function: 'blocked',
					require: "Module 'node:fs' is disallowed",
					bindings: [],
				},
			},
		]);
	});

	it('keeps changes to globals and prototypes inside one task', async () => {
		const mutated = await run(`
Object.prototype.n8nProbe = true;
Array.prototype.push = () => 0;
JSON.stringify = () => '"changed"';
JSON.parse = () => ({ changed: true });
globalThis.n8nProbe = true;
return [{ json: { changed: true } }];`);
		expect(resultOf(mutated)).toEqual([{ json: { changed: true } }]);
		expect(mutated.host).toEqual({ prototype: false, json: '{"clean":true}', global: false });
		const next = await run(`
return [{ json: {
	prototype: Object.hasOwn(Object.prototype, 'n8nProbe'),
	global: Object.hasOwn(globalThis, 'n8nProbe'),
	json: JSON.stringify({ clean: true }),
	push: [].push(1),
} }];`);
		expect(resultOf(next)).toEqual([
			{ json: { prototype: false, global: false, json: '{"clean":true}', push: 1 } },
		]);
	});
});

describe('Python Code node in a Dynamic Worker', () => {
	let worker: Worker;
	beforeAll(async () => {
		worker = await startLoaderWorker(true);
	});
	afterAll(async () => {
		await worker?.dispose();
	});

	const run = async (code: string, options?: Record<string, unknown>) =>
		await runIn(worker, code, options, { jobType: 'python' });

	it('runs once for all items and once for each item with the stock runner API', async () => {
		const all = await run(
			'print("items", len(_items))\nreturn [{"json": {"n": item["json"]["n"] * 2}} for item in _items]',
		);
		expect(resultOf(all)).toEqual([{ json: { n: 2 } }, { json: { n: 4 } }]);
		expect(all.logs).toEqual([["'items'", '2']]);
		console.log(`Python task latency (ms): ${all.elapsedMs.toFixed(0)}`);
		const each = await run(
			'if _item["json"]["n"] == 1:\n    return None\nreturn {"value": _item["json"]["n"] * 10}',
			{ nodeMode: 'runOnceForEachItem' },
		);
		expect(resultOf(each)).toEqual([{ json: { value: 20 }, pairedItem: { item: 1 } }]);
	});

	it('reports errors and blocked imports like the stock runner', async () => {
		const thrown = await run('x = 1\nraise ValueError("bad value")');
		expect(thrown.output).toMatchObject({ ok: false, error: { message: 'bad value' } });
		const syntax = await run('return [');
		expect(syntax.output).toMatchObject({ ok: false });
		const blocked = await run('import os\nreturn []');
		expect(blocked.output).toMatchObject({
			ok: false,
			error: { message: 'Security violations detected' },
		});
		const continued = await run('raise ValueError("bad value")', { continueOnFail: true });
		expect(resultOf(continued)).toEqual([{ json: { error: 'bad value' } }]);
	});

	it('gives Python code no host process, bindings or network', async () => {
		const probes = {
			importJs: 'import js\nreturn []',
			importPyodide: 'import pyodide\nreturn []',
			importWorkers: 'import workers\nreturn []',
			dunderImport: '__import__("js")\nreturn []',
			builtinsImport: '__builtins__["__import__"]("js")\nreturn []',
			subclasses: 'return [{"json": {"n": len(().__class__.__base__.__subclasses__())}}]',
			eval: 'eval("1")\nreturn []',
			open: 'open("/etc/passwd")\nreturn []',
		};
		for (const [name, code] of Object.entries(probes)) {
			const data = await run(code);
			expect(data.output.ok, `${name}: ${JSON.stringify(data.output)}`).toBe(false);
		}
	});
});

describe('Code node without the LOADER binding', () => {
	let worker: Worker;
	beforeAll(async () => {
		worker = await startLoaderWorker(false);
	});
	afterAll(async () => {
		await worker?.dispose();
	});

	// The interpreter shares the isolate with secrets, so a missing loader must not fall back silently.
	it('refuses to run user code', async () => {
		const data = await runIn(worker, `return [{ json: { ran: true } }];`);
		expect(data.output.ok).toBe(false);
		expect('result' in data.output).toBe(false);
	});
});
