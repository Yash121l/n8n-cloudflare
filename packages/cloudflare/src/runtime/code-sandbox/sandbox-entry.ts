// Runs in a Dynamic Worker: a fresh isolate with no bindings and no network.
// Port of JsTaskRunner (packages/@n8n/task-runner/src/js-task-runner/js-task-runner.ts).
import { WorkerEntrypoint } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { clearImmediate, setImmediate } from 'node:timers';
import { createExecutionCustomData } from 'n8n-core/dist/execution-engine/node-execution-context/utils/custom-data';
import { Workflow, WorkflowDataProxy, jsonStringify, setExpressionEvaluator } from 'n8n-workflow';
import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	INodeTypes,
	IWorkflowDataProxyAdditionalKeys,
	NodeParameterValueType,
} from 'n8n-workflow';
import runUserCode from 'n8n-code.cjs';

import { SvalEvaluator } from '../sval-evaluator';
import { isRecord, restoreBuffers, toTaskError } from './shared';
import { EXPOSED_HELPERS } from './types';
import type { FunctionItemOutcome, HelperBridge, SandboxResult, SandboxTask } from './types';

// Bound before user code runs, which can replace JSON in this isolate.
const { parse, stringify } = JSON;

const CONSOLE_METHODS = [
	'warn',
	'error',
	'info',
	'debug',
	'trace',
	'dir',
	'time',
	'timeEnd',
	'timeLog',
	'assert',
	'clear',
	'count',
	'countReset',
	'group',
	'groupEnd',
	'groupCollapsed',
	'table',
	'dirxml',
	'profile',
	'profileEnd',
	'timeStamp',
];

const expose = (values: Record<string, unknown>) => {
	for (const [key, value] of Object.entries(values)) {
		Object.defineProperty(globalThis, key, {
			value,
			writable: true,
			configurable: true,
			enumerable: true,
		});
	}
};

const consoleWith = (log: (...args: unknown[]) => void): Record<string, unknown> => ({
	...Object.fromEntries(CONSOLE_METHODS.map((name) => [name, () => {}])),
	log,
});

type FunctionItem = INodeExecutionData & { index: number };

interface FunctionNodeContext {
	workflow: Workflow;
	additionalKeys: IWorkflowDataProxyAdditionalKeys;
	dataProxy: (itemIndex: number) => IDataObject;
	helpers: Record<string, (...args: unknown[]) => Promise<unknown>>;
	sendMessageToUI: (...args: unknown[]) => void;
	execute: () => Promise<unknown>;
}

function extractJsonData(value: unknown) {
	if (!isRecord(value)) return value;
	if ('json' in value) return value.json;
	if ('binary' in value) return {};
	return value;
}

/** Port of TaskRunnerNodeTypes (packages/@n8n/task-runner/src/node-types.ts). */
class SandboxNodeTypes implements INodeTypes {
	readonly #byName = new Map<string, Map<number, INodeTypeDescription>>();

	constructor(descriptions: INodeTypeDescription[]) {
		for (const description of descriptions) {
			const versions = Array.isArray(description.version)
				? description.version
				: [description.version ?? 1];
			const byVersion =
				this.#byName.get(description.name) ?? new Map<number, INodeTypeDescription>();
			for (const version of versions) byVersion.set(version, description);
			this.#byName.set(description.name, byVersion);
		}
	}

	getByName(name: string): INodeType {
		return this.getByNameAndVersion(name);
	}

	getByNameAndVersion(name: string, version?: number): INodeType {
		const versions = this.#byName.get(name);
		const description = versions?.get(version ?? Math.max(...versions.keys()));
		// Like the task runner: an unknown type is undefined, and Workflow skips it.
		return (description ? { description } : undefined) as INodeType;
	}

	getKnownTypes() {
		return {};
	}
}

export default class CodeSandbox extends WorkerEntrypoint {
	async execute(serialized: string, bridge: HelperBridge): Promise<string> {
		const task: SandboxTask = parse(serialized);
		const pendingLogs: Array<Promise<void>> = [];
		try {
			const result = await this.run(task, bridge, pendingLogs);
			await Promise.allSettled(pendingLogs);
			return stringify(result);
		} catch (error) {
			await Promise.allSettled(pendingLogs);
			return stringify({ error: toTaskError(error) } satisfies SandboxResult);
		}
	}

	private async run(
		task: SandboxTask,
		bridge: HelperBridge,
		pendingLogs: Array<Promise<void>>,
	): Promise<SandboxResult> {
		const { settings } = task;
		// Like the vm context of the task runner: no process, require resolves no modules.
		const sandboxRequire = (name: string) => {
			throw new Error(`Module '${name}' is disallowed`);
		};
		const sandboxModule = { exports: {} };
		expose({
			process: undefined,
			require: sandboxRequire,
			module: sandboxModule,
			global: globalThis,
		});
		const execute = async () => await runUserCode(sandboxRequire, sandboxModule);

		if (settings.nodeMode === 'runCode') {
			expose({ __isExecutionContext: true, ...settings.additionalProperties });
			return { result: await execute() };
		}

		setExpressionEvaluator(SvalEvaluator);
		const workflow = new Workflow({
			...task.workflow,
			nodeTypes: new SandboxNodeTypes(task.nodeTypes),
		});
		const additionalKeys: IWorkflowDataProxyAdditionalKeys = {
			...task.additionalKeys,
			$execution: task.additionalKeys.$execution && {
				...task.additionalKeys.$execution,
				customData: createExecutionCustomData({
					runExecutionData: task.runExecutionData,
					mode: task.mode,
				}),
			},
		};
		const dataProxy = (itemIndex: number) =>
			new WorkflowDataProxy(
				workflow,
				task.runExecutionData,
				task.runIndex,
				itemIndex,
				task.activeNodeName,
				task.connectionInputData,
				task.siblingParameters,
				task.mode,
				additionalKeys,
				task.executeData,
				undefined,
				undefined,
				undefined,
				task.envProviderState,
			).getDataProxy({ throwOnMissingExecutionData: false });

		const console = consoleWith((...args: unknown[]) => {
			const formatted = args.map((arg) => {
				if (isRecord(arg) && '__isExecutionContext' in arg) return '[[ExecutionContext]]';
				if (typeof arg === 'string') return `'${arg}'`;
				return jsonStringify(arg, { replaceCircularRefs: true });
			});
			pendingLogs.push(bridge.log(formatted));
		});
		// The Function nodes send console.log arguments to sendMessageToUI as they are. logNodeOutput parses each JSON string back.
		const sendMessageToUI = (...args: unknown[]) => {
			pendingLogs.push(
				bridge.log(args.map((arg) => jsonStringify(arg, { replaceCircularRefs: true }) ?? 'null')),
			);
		};
		const helpers = Object.fromEntries(
			EXPOSED_HELPERS.map((name) => [
				name,
				async (...args: unknown[]) => restoreBuffers(await bridge.call(name, args)),
			]),
		);
		const base = {
			__isExecutionContext: true,
			console,
			$getWorkflowStaticData: (type: 'global' | 'node') => workflow.getStaticData(type, task.node),
			Buffer,
			setImmediate,
			clearImmediate,
			helpers,
		};

		let result: unknown;
		if (settings.nodeMode === 'function' || settings.nodeMode === 'functionItem') {
			result = await this.runFunctionNode(task, {
				workflow,
				additionalKeys,
				dataProxy,
				helpers,
				sendMessageToUI,
				execute,
			});
		} else if (settings.nodeMode === 'runOnceForAllItems') {
			expose({
				...base,
				...dataProxy(task.itemIndex),
				items: task.connectionInputData,
				...settings.additionalProperties,
			});
			try {
				result = await execute();
				if (result === null) result = [];
			} catch (error) {
				if (!settings.continueOnFail) throw error;
				result = [{ json: { error: toTaskError(error).message } }];
			}
		} else {
			expose({ ...base, ...settings.additionalProperties });
			const output: unknown[] = [];
			const start = settings.chunk?.startIndex ?? 0;
			const end = settings.chunk ? start + settings.chunk.count : task.connectionInputData.length;
			for (let index = start; index < end; index++) {
				expose({ ...dataProxy(index), item: task.connectionInputData[index] });
				try {
					const value = await execute();
					if (!value) continue;
					const binary = isRecord(value) ? value.binary : undefined;
					output.push({
						json: extractJsonData(value),
						pairedItem: { item: index },
						...(binary ? { binary } : {}),
					});
				} catch (error) {
					if (!settings.continueOnFail) throw error;
					output.push({ json: { error: toTaskError(error).message }, pairedItem: { item: index } });
				}
			}
			result = output;
		}

		return {
			result,
			customData: task.runExecutionData.resultData.metadata,
			staticData: workflow.staticData.__dataChanged ? workflow.staticData : undefined,
		};
	}

	/** Port of the sandbox globals of the Function and Function Item nodes (packages/nodes-base/nodes/Function*). */
	private async runFunctionNode(task: SandboxTask, context: FunctionNodeContext): Promise<unknown> {
		const { workflow, additionalKeys, dataProxy, helpers, sendMessageToUI, execute } = context;
		const getNodeParameter = (name: string, itemIndex = 0, fallbackValue?: unknown) => {
			const value = name
				.split('.')
				.reduce<unknown>(
					(parent, key) => (isRecord(parent) ? parent[key] : undefined),
					task.node.parameters,
				);
			return workflow.expression.getParameterValue(
				(value ?? fallbackValue) as NodeParameterValueType,
				task.runExecutionData,
				task.runIndex,
				itemIndex,
				task.activeNodeName,
				task.connectionInputData,
				task.mode,
				additionalKeys,
				task.executeData,
			);
		};
		const copyItem = (index: number): FunctionItem => ({
			...parse(stringify(task.connectionInputData[index])),
			index,
		});
		const getBinaryData = async (item: FunctionItem) => {
			// Cannot check item with `if (item?.index)`, as index may be 0.
			if (item?.binary && item?.index !== undefined && item?.index !== null) {
				for (const name of Object.keys(item.binary)) {
					const buffer = (await helpers.getBinaryDataBuffer(item.index, name)) as
						| Buffer
						| undefined;
					Object.assign(item.binary[name], { data: buffer?.toString('base64') });
				}
			}
			return item.binary;
		};
		const setBinaryData = async (item: FunctionItem, data: FunctionItem['binary']) => {
			for (const name of Object.keys(data ?? {})) {
				const binary = data![name];
				data![name] = (await helpers.setBinaryDataBuffer(
					binary,
					Buffer.from(binary.data ?? '', 'base64'),
				)) as typeof binary;
			}
			item.binary = data;
		};
		const globals = {
			console: consoleWith(sendMessageToUI),
			getNodeParameter,
			getWorkflowStaticData: (type: 'global' | 'node') => workflow.getStaticData(type, task.node),
			helpers,
			Buffer,
			setImmediate,
			clearImmediate,
		};

		if (task.settings.nodeMode === 'function') {
			const items = task.connectionInputData.map((_item, index) => copyItem(index));
			expose({
				...globals,
				items,
				$item: dataProxy,
				getBinaryDataAsync: getBinaryData,
				setBinaryDataAsync: async (item: FunctionItem, data: FunctionItem['binary']) => {
					if (!item)
						throw new Error(
							'No item was provided to setBinaryDataAsync (item: INodeExecutionData, data: IBinaryKeyData).',
						);
					if (!data)
						throw new Error(
							'No data was provided to setBinaryDataAsync (item: INodeExecutionData, data: IBinaryKeyData).',
						);
					await setBinaryData(item, data);
				},
				...dataProxy(0),
			});
			return await execute();
		}

		const outcomes: FunctionItemOutcome[] = [];
		for (let index = 0; index < task.connectionInputData.length; index++) {
			const item = copyItem(index);
			const deprecated = (name: string) => {
				if (task.mode !== 'manual') return;
				sendMessageToUI(
					`${name}(...) is deprecated and will be removed in a future version. Please consider switching to ${name}Async(...) instead.`,
				);
			};
			try {
				expose({
					...globals,
					item: item.json,
					getBinaryData: () => {
						deprecated('getBinaryData');
						return item.binary;
					},
					setBinaryData: async (data: FunctionItem['binary']) => {
						deprecated('setBinaryData');
						item.binary = data;
					},
					getBinaryDataAsync: async () => await getBinaryData(item),
					setBinaryDataAsync: async (data: FunctionItem['binary']) => {
						if (!data)
							throw new Error('No data was provided to setBinaryDataAsync (data: IBinaryKeyData).');
						await setBinaryData(item, data);
					},
					...dataProxy(index),
				});
				const json = await execute();
				outcomes.push({ json, binary: item.binary });
				if (json === undefined && !task.settings.continueOnFail) break;
			} catch (error) {
				outcomes.push({ error: toTaskError(error) });
				if (!task.settings.continueOnFail) break;
			}
		}
		return outcomes;
	}
}
