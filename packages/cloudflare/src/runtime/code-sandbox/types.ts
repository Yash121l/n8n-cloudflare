import type {
	EnvProviderState,
	IDataObject,
	IExecuteData,
	INode,
	INodeExecutionData,
	INodeParameters,
	INodeTypeDescription,
	IRunExecutionData,
	IWorkflowDataProxyAdditionalKeys,
	WorkflowExecuteMode,
	WorkflowParameters,
} from 'n8n-workflow';

/**
 * Settings the Code node sends to `startJob('javascript', ...)` (see JsTaskRunnerSandbox).
 * `function` and `functionItem` come from the legacy Function nodes, see legacy-function.ts.
 */
export interface JsExecSettings {
	code: string;
	nodeMode: 'runOnceForAllItems' | 'runOnceForEachItem' | 'runCode' | 'function' | 'functionItem';
	workflowMode: WorkflowExecuteMode;
	continueOnFail: boolean;
	chunk?: { startIndex: number; count: number };
	additionalProperties?: Record<string, unknown>;
}

export const isJsExecSettings = (value: unknown): value is JsExecSettings =>
	typeof value === 'object' &&
	value !== null &&
	'code' in value &&
	typeof value.code === 'string' &&
	'nodeMode' in value;

/** Like `DataRequestResponse` of the task runner: the data the sandbox needs to rebuild a WorkflowDataProxy. */
export interface SandboxTask {
	workflow: Omit<WorkflowParameters, 'nodeTypes'>;
	nodeTypes: INodeTypeDescription[];
	runExecutionData: IRunExecutionData;
	node: INode;
	runIndex: number;
	itemIndex: number;
	activeNodeName: string;
	connectionInputData: INodeExecutionData[];
	siblingParameters: INodeParameters;
	mode: WorkflowExecuteMode;
	envProviderState: EnvProviderState;
	executeData?: IExecuteData;
	/** `$execution.customData` is rebuilt in the sandbox from `runExecutionData`. */
	additionalKeys: Omit<IWorkflowDataProxyAdditionalKeys, '$execution'> & {
		$execution?: Omit<NonNullable<IWorkflowDataProxyAdditionalKeys['$execution']>, 'customData'>;
	};
	settings: JsExecSettings;
}

/** Like `TaskResultData` of the task runner, plus an error in the shape `ExecutionError` serializes to. */
export interface SandboxResult {
	result?: unknown;
	customData?: Record<string, string>;
	staticData?: IDataObject;
	error?: Record<string, unknown> & { message: string };
}

export type TaskError = NonNullable<SandboxResult['error']>;

/** One item of a `functionItem` task: the returned value and the item binary, or the error. */
export type FunctionItemOutcome = { json?: unknown; binary?: unknown } | { error: TaskError };

/** Same list as `EXPOSED_RPC_METHODS` in @n8n/task-runner. */
export const EXPOSED_HELPERS = [
	'assertBinaryData',
	'getBinaryDataBuffer',
	'prepareBinaryData',
	'setBinaryDataBuffer',
	'binaryToString',
	'httpRequest',
	'request',
] as const;

export type HelperName = (typeof EXPOSED_HELPERS)[number];

export const isHelperName = (value: unknown): value is HelperName =>
	EXPOSED_HELPERS.some((name) => name === value);

/** The RPC surface the sandbox can call in the main isolate. */
export interface HelperBridge {
	call(name: HelperName, args: unknown[]): Promise<unknown>;
	/** Same as the `logNodeOutput` RPC of the task runner: one formatted string for each argument. */
	log(args: string[]): Promise<void>;
}

/** Same default as N8N_RUNNERS_TASK_TIMEOUT. */
export const TASK_TIMEOUT_MS = 300_000;

/** Name of the module that holds the user code in the Dynamic Worker. */
export const USER_CODE_MODULE = 'n8n-code.cjs';
