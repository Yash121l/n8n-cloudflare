import { env } from 'cloudflare:workers';
import { getAdditionalKeys, setWorkflowExecutionMetadata } from 'n8n-core';
import type {
	EnvProviderState,
	IDataObject,
	IExecuteData,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeParameters,
	IRunExecutionData,
	ITaskDataConnections,
	IWorkflowExecuteAdditionalData,
	Workflow,
	WorkflowExecuteMode,
} from 'n8n-workflow';
import { WorkflowDataProxy, createRunExecutionData, jsonStringify } from 'n8n-workflow';
import type { Result } from '@n8n/utils/result';
import { createResultError, createResultOk } from '@n8n/utils/result';
import Sval from 'sval';

import type { Env } from '../env';
import { logNodeOutput } from './code-sandbox/shared';
import { EXPOSED_HELPERS, isJsExecSettings } from './code-sandbox/types';
import type { JsExecSettings, SandboxTask } from './code-sandbox/types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const CONSOLE_METHODS = [
	'error',
	'warn',
	'info',
	'debug',
	'trace',
	'dir',
	'time',
	'timeEnd',
	'group',
	'groupEnd',
	'table',
];

function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (isRecord(error) && typeof error.message === 'string') {
		return Object.assign(new Error(error.message), error);
	}
	return new Error(JSON.stringify(error));
}

interface TaskInput {
	additionalData: IWorkflowExecuteAdditionalData;
	executeFunctions: IExecuteFunctions;
	node: INode;
	workflow: Workflow;
	runExecutionData: IRunExecutionData;
	runIndex: number;
	activeNodeName: string;
	connectionInputData: INodeExecutionData[];
	siblingParameters: INodeParameters;
	mode: WorkflowExecuteMode;
	envProviderState: EnvProviderState;
	executeData?: IExecuteData;
}

function dataProxy(input: TaskInput, itemIndex: number) {
	return new WorkflowDataProxy(
		input.workflow,
		input.runExecutionData,
		input.runIndex,
		itemIndex,
		input.activeNodeName,
		input.connectionInputData,
		input.siblingParameters,
		input.mode,
		getAdditionalKeys(input.additionalData, input.mode, input.runExecutionData),
		input.executeData,
		undefined,
		undefined,
		undefined,
		input.envProviderState,
	).getDataProxy({ throwOnMissingExecutionData: false });
}

function baseContext(input: TaskInput, additionalProperties: Record<string, unknown> = {}) {
	const { executeFunctions, workflow, node } = input;
	const helpers: Record<string, unknown> = {};
	for (const name of EXPOSED_HELPERS) {
		const helper = executeFunctions.helpers[name];
		if (typeof helper === 'function') helpers[name] = helper.bind(executeFunctions.helpers);
	}
	const console: Record<string, unknown> = Object.fromEntries(
		CONSOLE_METHODS.map((m) => [m, () => {}]),
	);
	console.log = (...args: unknown[]) => {
		const formatted = args.map((arg) => {
			if (isRecord(arg) && '__isExecutionContext' in arg) return '[[ExecutionContext]]';
			return typeof arg === 'string'
				? `'${arg}'`
				: jsonStringify(arg, { replaceCircularRefs: true });
		});
		logNodeOutput(executeFunctions, formatted);
	};
	return {
		__isExecutionContext: true,
		console,
		helpers,
		$getWorkflowStaticData: (type: 'global' | 'node') => workflow.getStaticData(type, node),
		Buffer,
		setTimeout,
		setInterval,
		clearTimeout,
		clearInterval,
		btoa,
		atob,
		TextDecoder,
		TextEncoder,
		FormData,
		...additionalProperties,
	};
}

const HOST_GLOBALS_HIDDEN: Record<string, undefined> = {
	process: undefined,
	require: undefined,
	module: undefined,
	navigator: undefined,
	caches: undefined,
	fetch: undefined,
	WebSocket: undefined,
	scheduler: undefined,
	crypto: undefined,
	setImmediate: undefined,
	Deno: undefined,
	Bun: undefined,
};

/**
 * Supports local tools without Worker Loader. This interpreter is not an isolation boundary.
 */
class Script {
	private readonly interpreter = new Sval({
		ecmaVer: 'latest',
		sourceType: 'script',
		sandBox: true,
	});

	constructor(code: string, context: Record<string, unknown>) {
		// The sandbox global inherits host globals. Shadow the ones that reach the host.
		this.interpreter.import(HOST_GLOBALS_HIDDEN);
		this.interpreter.import(context);
		this.interpreter.run(
			`var module = { exports: {} }; globalThis.global = globalThis;\nexports.run = async function VmCodeWrapper() {${code}\n};`,
		);
	}

	setGlobals(values: Record<string, unknown>) {
		this.interpreter.import(values);
	}

	async run(): Promise<unknown> {
		const exports: Record<string, unknown> = this.interpreter.exports;
		const fn = exports.run;
		if (typeof fn !== 'function') throw new Error('Code could not be compiled');
		return await fn();
	}
}

function extractJsonData(result: unknown) {
	if (!isRecord(result)) return result;
	if ('json' in result) return result.json;
	if ('binary' in result) return {};
	return result;
}

async function runForAllItems(input: TaskInput, settings: JsExecSettings, itemIndex: number) {
	const context = {
		...baseContext(input, { items: input.connectionInputData, ...settings.additionalProperties }),
		...dataProxy(input, itemIndex),
	};
	try {
		const result = await new Script(settings.code, context).run();
		return result === null ? [] : result;
	} catch (e) {
		const error = toError(e);
		if (settings.continueOnFail) return [{ json: { error: error.message } }];
		throw error;
	}
}

async function runForEachItem(input: TaskInput, settings: JsExecSettings) {
	const items = input.connectionInputData;
	const start = settings.chunk?.startIndex ?? 0;
	const end = settings.chunk ? start + settings.chunk.count : items.length;
	const script = new Script(settings.code, baseContext(input, settings.additionalProperties));
	const returnData: INodeExecutionData[] = [];

	for (let index = start; index < end; index++) {
		script.setGlobals({ ...dataProxy(input, index), item: items[index] });
		try {
			const result = await script.run();
			if (result === null || result === undefined) continue;
			const json = extractJsonData(result);
			const binary = isRecord(result) ? result.binary : undefined;
			returnData.push({
				json: isRecord(json) ? (json as IDataObject) : {},
				pairedItem: { item: index },
				...(binary ? { binary: binary as INodeExecutionData['binary'] } : {}),
			});
		} catch (e) {
			const error = toError(e);
			if (!settings.continueOnFail) throw error;
			returnData.push({ json: { error: error.message }, pairedItem: { item: index } });
		}
	}
	return returnData;
}

/** Undefined for a type that is not loaded, like TaskRunnerNodeTypes returns for an unknown type. */
function nodeTypeDescription(workflow: Workflow, node: INode) {
	try {
		return workflow.nodeTypes.getByNameAndVersion(node.type, node.typeVersion)?.description;
	} catch {
		return undefined;
	}
}

/** Like DataRequestResponseBuilder in packages/cli/src/task-runners/task-managers. */
function buildSandboxTask(
	input: TaskInput,
	settings: JsExecSettings,
	itemIndex: number,
): SandboxTask {
	const { workflow, runExecutionData, additionalData, mode } = input;
	const keys = getAdditionalKeys(additionalData, mode, runExecutionData);
	const execution = keys.$execution && {
		id: keys.$execution.id,
		mode: keys.$execution.mode,
		resumeUrl: keys.$execution.resumeUrl,
		resumeFormUrl: keys.$execution.resumeFormUrl,
	};
	const nodeTypes = new Map<string, SandboxTask['nodeTypes'][number]>();
	for (const node of Object.values(workflow.nodes)) {
		const key = `${node.type}@${node.typeVersion}`;
		if (nodeTypes.has(key)) continue;
		const description = nodeTypeDescription(workflow, node);
		// Loaded node modules carry the short name. Stock sends the full name, which the data proxy looks up.
		if (description) nodeTypes.set(key, { ...description, name: node.type });
	}
	return {
		workflow: {
			id: workflow.id,
			name: workflow.name,
			active: workflow.active,
			connections: workflow.connectionsBySourceNode,
			nodes: Object.values(workflow.nodes),
			pinData: workflow.pinData,
			settings: workflow.settings,
			staticData: workflow.staticData,
		},
		nodeTypes: [...nodeTypes.values()],
		runExecutionData: createRunExecutionData({
			startData: runExecutionData.startData,
			resultData: runExecutionData.resultData,
			executionData: runExecutionData.executionData
				? {
						contextData: runExecutionData.executionData.contextData,
						metadata: runExecutionData.executionData.metadata,
						nodeExecutionStack: [],
						waitingExecution: {},
						waitingExecutionSource: null,
					}
				: undefined,
			resumeToken: runExecutionData.resumeToken,
		}),
		node: input.node,
		runIndex: input.runIndex,
		itemIndex,
		activeNodeName: input.activeNodeName,
		connectionInputData: input.connectionInputData,
		siblingParameters: input.siblingParameters,
		mode,
		// The Worker has no process environment to expose, so `$env` stays blocked.
		envProviderState: { env: {}, isEnvAccessBlocked: true, isProcessAvailable: false },
		executeData: input.executeData,
		additionalKeys: { ...keys, $execution: execution, $secrets: undefined },
		settings,
	};
}

let warnedAboutFallback = false;

/** In-process replacement for `TaskRequester.startTask` (packages/cli/src/task-runners). */
export async function startRunnerTask<T, E = unknown>(
	additionalData: IWorkflowExecuteAdditionalData,
	jobType: string,
	settings: unknown,
	executeFunctions: IExecuteFunctions,
	_inputData: ITaskDataConnections,
	node: INode,
	workflow: Workflow,
	runExecutionData: IRunExecutionData,
	runIndex: number,
	itemIndex: number,
	activeNodeName: string,
	connectionInputData: INodeExecutionData[],
	siblingParameters: INodeParameters,
	mode: WorkflowExecuteMode,
	envProviderState: EnvProviderState,
	executeData?: IExecuteData,
): Promise<Result<T, E>> {
	try {
		if (jobType === 'python') return await startPythonTask<T, E>(settings, executeFunctions);
		if (jobType !== 'javascript') {
			throw new Error(`The ${jobType} runner is not available on Cloudflare Workers`);
		}
		if (!isJsExecSettings(settings)) throw new Error('Invalid Code node settings');
		const input: TaskInput = {
			additionalData,
			executeFunctions,
			node,
			workflow,
			runExecutionData,
			runIndex,
			activeNodeName,
			connectionInputData,
			siblingParameters,
			mode,
			envProviderState,
			executeData,
		};
		const { LOADER } = env as unknown as Env;
		if (LOADER) {
			const started = Date.now();
			// Lazy, so the sandbox source loads only in isolates that run a Code node.
			const { runInDynamicWorker } = await import('./code-sandbox/host');
			const output = await runInDynamicWorker(
				LOADER,
				buildSandboxTask(input, settings, itemIndex),
				executeFunctions,
			);
			console.debug(
				`Code node "${node.name}" ran in a Dynamic Worker in ${Date.now() - started} ms`,
			);
			// The task runner returns a plain error object. The Code node wraps it in WrappedExecutionError.
			if (output.error) return createResultError(output.error as E);
			// Same as TaskRequester.startTask: custom data goes to the run metadata, changed static data replaces the workflow copy.
			if (isRecord(output.customData)) {
				for (const [key, value] of Object.entries(output.customData)) {
					// User code shares a realm with the sandbox serializer, so the custom data limits apply again here.
					try {
						setWorkflowExecutionMetadata(runExecutionData, key, value);
					} catch {
						// An invalid entry is dropped, like a rejected `customData.set` outside manual mode.
					}
				}
			}
			if (output.staticData) workflow.overrideStaticData(output.staticData);
			return createResultOk(output.result as T);
		}
		// Fail closed: the interpreter shares the isolate with secrets, so it runs only on explicit opt-in.
		if (Reflect.get(env, 'N8N_CODE_ALLOW_UNSAFE_SVAL') !== 'true') {
			throw new Error(
				'The Code node cannot run: the LOADER Worker Loader binding is missing. Add "worker_loaders" to wrangler.jsonc.',
			);
		}
		if (settings.nodeMode === 'function' || settings.nodeMode === 'functionItem') {
			throw new Error(
				'The Function node runs only in a Dynamic Worker. Add "worker_loaders" to wrangler.jsonc.',
			);
		}
		if (!warnedAboutFallback) {
			warnedAboutFallback = true;
			console.warn(
				'N8N_CODE_ALLOW_UNSAFE_SVAL is set. The Code node runs in the sval interpreter, which does not isolate user code.',
			);
		}
		console.debug(`Code node "${node.name}" ran in the sval interpreter`);
		let result: unknown;
		if (settings.nodeMode === 'runCode') {
			result = await new Script(settings.code, {
				__isExecutionContext: true,
				...settings.additionalProperties,
			}).run();
		} else if (settings.nodeMode === 'runOnceForAllItems') {
			result = await runForAllItems(input, settings, itemIndex);
		} else {
			result = await runForEachItem(input, settings);
		}
		return createResultOk(result as T);
	} catch (e) {
		return createResultError(e as E);
	}
}

/** Python runs only in a Dynamic Worker. The interpreter fallback is JavaScript only. */
async function startPythonTask<T, E>(
	settings: unknown,
	executeFunctions: IExecuteFunctions,
): Promise<Result<T, E>> {
	const { LOADER } = env as unknown as Env;
	if (!LOADER)
		throw new Error(
			'Python cannot run: the LOADER Worker Loader binding is missing. Add "worker_loaders" to wrangler.jsonc.',
		);
	const { isPythonExecSettings, runPythonInDynamicWorker } = await import(
		'./code-sandbox/python-host'
	);
	if (!isPythonExecSettings(settings)) throw new Error('Invalid Code node settings');
	const output = await runPythonInDynamicWorker(LOADER, settings, executeFunctions);
	if (output.error) return createResultError(output.error as E);
	return createResultOk(output.result as T);
}

export function getRunnerStatus(taskType: string) {
	if (taskType === 'javascript') return { available: true } as const;
	if (taskType === 'python' && (env as unknown as Env).LOADER) return { available: true } as const;
	// The Code node maps the reason to a text about a local Python install, which does not apply here.
	return { available: false } as const;
}
