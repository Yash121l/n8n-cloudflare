import type { IExecuteFunctions } from 'n8n-workflow';

import { PYTHON_MAIN_MODULE, PYTHON_MODULES } from './python.generated';
import { isRecord, logNodeOutput } from './shared';
import { TASK_TIMEOUT_MS } from './types';

/** Settings the Code node sends to `startJob('python', ...)` (see PythonTaskRunnerSandbox). */
export interface PythonExecSettings {
	code: string;
	nodeMode: 'runOnceForAllItems' | 'runOnceForEachItem';
	continueOnFail: boolean;
	items?: unknown[];
	query?: unknown;
}

export const isPythonExecSettings = (value: unknown): value is PythonExecSettings =>
	isRecord(value) && typeof value.code === 'string' && typeof value.nodeMode === 'string';

interface PythonOutput {
	result?: unknown;
	print_args?: unknown[];
	error?: { message: string; description?: string };
}

const isPythonOutput = (value: unknown): value is PythonOutput =>
	isRecord(value) &&
	(!('error' in value) || (isRecord(value.error) && typeof value.error.message === 'string'));

/**
 * Runs one Python Code task in a new Python Dynamic Worker. The runtime provides Pyodide.
 * The worker runs the executor of the stock Python task runner, with its default import and builtin rules.
 */
export async function runPythonInDynamicWorker(
	loader: WorkerLoader,
	settings: PythonExecSettings,
	functions: IExecuteFunctions,
): Promise<PythonOutput> {
	const modules = Object.fromEntries(
		Object.entries(PYTHON_MODULES).map(([name, py]) => [name, { py }]),
	);
	const worker = loader.load({
		compatibilityDate: '2026-10-01',
		compatibilityFlags: ['python_workers'],
		mainModule: PYTHON_MAIN_MODULE,
		modules,
		env: {},
		globalOutbound: null,
		limits: { cpuMs: TASK_TIMEOUT_MS },
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`Task execution timed out after ${TASK_TIMEOUT_MS / 1000} seconds`)),
				TASK_TIMEOUT_MS,
			);
		});
		const body = JSON.stringify({
			code: settings.code,
			nodeMode: settings.nodeMode,
			continueOnFail: settings.continueOnFail,
			items: settings.items ?? [],
			query: settings.query ?? null,
		});
		const response = await Promise.race([
			worker.getEntrypoint().fetch('http://python/', { method: 'POST', body }),
			timeout,
		]);
		const text = await response.text();
		const output: unknown = response.ok ? JSON.parse(text) : undefined;
		if (!isPythonOutput(output))
			throw new Error(`The Python sandbox failed: ${text.slice(0, 500)}`);
		// Like the `logNodeOutput` RPC of the Python runner: one call for each print().
		for (const args of output.print_args ?? []) {
			if (Array.isArray(args)) logNodeOutput(functions, args.map(String));
		}
		return output;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
