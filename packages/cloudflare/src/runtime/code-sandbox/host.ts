import { RpcTarget } from 'cloudflare:workers';
import type { IExecuteFunctions } from 'n8n-workflow';
import { jsonStringify } from 'n8n-workflow';

import { SANDBOX_SOURCE } from './bundle.generated';
import { isRecord, logNodeOutput, restoreBuffers, toStartupError } from './shared';
import { TASK_TIMEOUT_MS, USER_CODE_MODULE, isHelperName } from './types';
import type { HelperBridge, HelperName, SandboxResult, SandboxTask } from './types';
import type CodeSandbox from './sandbox-entry';

/** The task runner side of the RPC: helpers run in the main isolate, like stock runs them in the main process. */
class CodeHelpers extends RpcTarget implements HelperBridge {
	readonly #functions: IExecuteFunctions;
	#active = true;

	constructor(functions: IExecuteFunctions) {
		super();
		this.#functions = functions;
	}

	close() {
		this.#active = false;
	}

	async call(name: HelperName, args: unknown[]): Promise<unknown> {
		if (!this.#active) throw new Error('The Code task has ended');
		if (!isHelperName(name) || !Array.isArray(args))
			throw new Error('This helper is not available in the Code node');
		const helper: unknown = this.#functions.helpers[name];
		if (typeof helper !== 'function') throw new Error(`The helper ${name} is not available`);
		return await Reflect.apply(helper, this.#functions.helpers, args.map(restoreBuffers));
	}

	async log(args: string[]): Promise<void> {
		if (!this.#active) throw new Error('The Code task has ended');
		if (!Array.isArray(args)) return;
		logNodeOutput(this.#functions, args.map(String));
	}
}

/** Keeps user line numbers: the wrapper and line 1 of the code share one line, like the task runner. */
function userCodeModule(code: string) {
	return `module.exports = function VmCodeModule(require, module, exports, __filename, __dirname) { return (async function VmCodeWrapper() {${code}\n})(); };`;
}

function isSandboxResult(value: unknown): value is SandboxResult {
	return (
		isRecord(value) &&
		(!('error' in value) || (isRecord(value.error) && typeof value.error.message === 'string'))
	);
}

/**
 * Runs one Code task in a new Dynamic Worker. `load()` never reuses an isolate, so globals
 * and prototypes that user code changes do not reach later tasks or other workflows.
 */
export async function runInDynamicWorker(
	loader: WorkerLoader,
	task: SandboxTask,
	functions: IExecuteFunctions,
): Promise<SandboxResult> {
	const worker = loader.load({
		compatibilityDate: '2026-10-01',
		compatibilityFlags: ['nodejs_compat'],
		mainModule: 'sandbox.js',
		modules: {
			'sandbox.js': SANDBOX_SOURCE,
			[USER_CODE_MODULE]: { cjs: userCodeModule(task.settings.code) },
		},
		env: {},
		globalOutbound: null,
		// Stops an endless loop in production. Local workerd does not enforce it.
		limits: { cpuMs: TASK_TIMEOUT_MS },
	});
	const bridge = new CodeHelpers(functions);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`Task execution timed out after ${TASK_TIMEOUT_MS / 1000} seconds`)),
				TASK_TIMEOUT_MS,
			);
		});
		const execution = worker
			.getEntrypoint<CodeSandbox>()
			.execute(jsonStringify(task, { replaceCircularRefs: true }), bridge);
		const serialized: unknown = await Promise.race([execution, timeout]);
		const result: unknown = typeof serialized === 'string' ? JSON.parse(serialized) : undefined;
		if (!isSandboxResult(result)) throw new Error('The Code sandbox returned an invalid result');
		return result;
	} catch (error) {
		const startupError = toStartupError(error);
		if (startupError) return { error: startupError };
		throw error;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		bridge.close();
	}
}
