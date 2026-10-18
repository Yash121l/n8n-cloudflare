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

function pythonNode(
	name: string,
	pythonCode: string,
	parameters: Record<string, unknown> = {},
	extra: Record<string, unknown> = {},
) {
	return codeNode(name, '', {
		parameters: { language: 'pythonNative', pythonCode, ...parameters },
		position: [400, 0],
		...extra,
	});
}

const source = codeNode(
	'Source',
	`return [{ json: { n: 1, name: 'a' } }, { json: { n: 2, name: 'b' } }];`,
);

// Each probe must fail.
const probes = {
	environ: 'import os\nreturn [{"json": {"key": os.environ.get("N8N_ENCRYPTION_KEY")}}]',
	js: 'import js\nreturn [{"json": {"keys": str(js.Object.keys(js.globalThis))}}]',
	pyodide: 'import pyodide\nreturn [{"json": {"ok": True}}]',
	workers: 'from workers import fetch\nreturn [{"json": {"ok": True}}]',
	importlib: 'import importlib\nreturn [{"json": {"m": str(importlib.import_module("js"))}}]',
	dunderImport: 'return [{"json": {"m": str(__import__("js"))}}]',
	subclasses: 'return [{"json": {"n": len(().__class__.__base__.__subclasses__())}}]',
	frames:
		'def f():\n    raise Exception()\ntry:\n    f()\nexcept Exception as e:\n    return [{"json": {"g": str(e.__traceback__.tb_frame.f_globals)}}]',
	format: 'return [{"json": {"g": "{0.__class__.__init__.__globals__}".format(_items)}}]',
	eval: 'return [{"json": {"v": eval("1 + 1")}}]',
	open: 'return [{"json": {"v": open("/proc/self/environ").read()}}]',
};

describe('Python in the Code node', () => {
	let instance: Instance;
	let session: Session;
	beforeAll(async () => {
		instance = await startInstance();
		session = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('runs Python for all items and for each item with print output', async () => {
		const workflow = await createWorkflow(
			session,
			'Python',
			[
				manualTrigger,
				source,
				pythonNode(
					'All Items',
					'import_ok = len(_items)\nprint("count", import_ok, {"first": _items[0]["json"]["name"]})\nreturn [{"json": {**item["json"], "double": item["json"]["n"] * 2}} for item in _items]',
				),
				pythonNode('Each Item', 'return {"json": {"upper": _item["json"]["name"].upper()}}', {
					mode: 'runOnceForEachItem',
				}),
			],
			chain('Manual', 'Source', 'All Items', 'Each Item'),
		);
		const { socket, messages } = await openPush(instance, session, 'code-python');
		const { status, data } = await runManually(session, workflow, 'code-python');
		socket.close();
		expect(status, JSON.stringify(data.resultData.error)).toBe('success');
		expect(outputOf(data, 'All Items')).toEqual([
			{ n: 1, name: 'a', double: 2 },
			{ n: 2, name: 'b', double: 4 },
		]);
		expect(outputOf(data, 'Each Item')).toEqual([{ upper: 'A' }, { upper: 'B' }]);
		const consoleMessages = messages.filter((message) => message.type === 'sendConsoleMessage');
		expect(consoleMessages.map((message) => message.data)).toEqual([
			{ source: '[Node: "All Items"]', messages: ["'count'", 2, { first: 'a' }] },
		]);
	});

	it('reports Python errors and continues on fail like the task runner', async () => {
		const failing = await createWorkflow(
			session,
			'Python error',
			[manualTrigger, source, pythonNode('Python', 'x = 1\nraise ValueError("bad value")')],
			chain('Manual', 'Source', 'Python'),
		);
		const failed = await runManually(session, failing);
		expect(failed.status).toBe('error');
		expect(failed.data.resultData.error).toMatchObject({ message: 'bad value' });

		const continuing = await createWorkflow(
			session,
			'Python continue',
			[
				manualTrigger,
				source,
				pythonNode(
					'Python',
					'raise ValueError("bad value")',
					{},
					{ onError: 'continueRegularOutput' },
				),
			],
			chain('Manual', 'Source', 'Python'),
		);
		const continued = await runManually(session, continuing);
		expect(continued.status, JSON.stringify(continued.data.resultData.error)).toBe('success');
		expect(outputOf(continued.data, 'Python')).toEqual([{ error: 'bad value' }]);
	});

	it('does not expose the encryption key, host process, bindings or network to Python code', async () => {
		for (const [name, code] of Object.entries(probes)) {
			const workflow = await createWorkflow(
				session,
				`Python probe ${name}`,
				[manualTrigger, source, pythonNode('Probe', code)],
				chain('Manual', 'Source', 'Probe'),
			);
			const { status, data } = await runManually(session, workflow);
			expect(status, `${name}: ${JSON.stringify(outputOf(data, 'Probe'))}`).toBe('error');
			expect(JSON.stringify(data)).not.toContain(ENCRYPTION_KEY);
			expect(data.resultData.error?.message, name).toMatch(
				/Security violations detected|is not defined|has no attribute/,
			);
		}
	});
});
