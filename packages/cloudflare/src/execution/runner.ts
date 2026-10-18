import * as a from 'node:assert/strict';

import { Container } from '@n8n/di';
import {
	BinaryDataService,
	FileLocation,
	DirectedGraph,
	ExecutionLifecycleHooks,
	ExternalSecretsProxy,
	WorkflowExecute,
	filterDisabledNodes,
	recreateNodeExecutionStack,
} from 'n8n-core';
import type {
	ExecuteWorkflowData,
	ExecutionError,
	ExecuteWorkflowOptions,
	ExecutionStatus,
	IDataObject,
	IDestinationNode,
	IExecuteData,
	IExecuteWorkflowInfo,
	INodeExecutionData,
	IPinData,
	IRun,
	IRunData,
	IRunExecutionData,
	IWorkflowBase,
	IWorkflowExecuteAdditionalData,
	StartNodeData,
	WorkflowExecuteMode,
} from 'n8n-workflow';
import {
	ExecutionCancelledError,
	ExpressionError,
	ManualExecutionCancelledError,
	NodeApiError,
	NodeOperationError,
	WorkflowActivationError,
	UnexpectedError,
	UserError,
	Workflow,
	collectSubWorkflowOutput,
	createRunExecutionData,
	getLastExecutedNodeData,
	getLastExecutedNodeRuns,
	getSubWorkflowOutputPolicy,
	isNodeConnectionType,
	mergeRunsPerBranch,
	SubworkflowOperationError,
	toErrorWorkflowContext,
	WorkflowOperationError,
} from 'n8n-workflow';
import type { INode, ITaskData, NodeConnectionType } from 'n8n-workflow';
import { parse, stringify } from 'flatted';

import type { WorkflowRow } from '../db/types';
import { nowIso, parseJson } from '../db/types';
import type { Env } from '../env';
import type { PushMessage } from '../push/push-hub';
import { pushHub } from '../push/push-hub';
import { bootstrap } from '../runtime/bootstrap';
import { checkWorkflowCredentials } from '../runtime/credential-access';
import { getRunnerStatus, startRunnerTask } from '../runtime/code-runner';
import { CredentialsHelper } from '../runtime/credentials-helper';
import { nodeTypes, preloadWorkflowTypes } from '../runtime/node-types';
import type { ExecutionVars } from './config';
import { executionsConfig } from './config';
import {
	createExecution,
	getExecutionRow,
	loadExecutionData,
	loadExecutionWorkflow,
	saveExecutionData,
	updateExecution,
} from './store';
import { runnerFor } from './execution-runner';
import { restoreBinaryDataId } from './restore-binary-data-id';

/** Serializable description of one run. It travels through Cloudflare Workflows params and R2. */
export interface RunRequest {
	executionId: string;
	executionMode: WorkflowExecuteMode;
	workflowData: IWorkflowBase;
	baseUrl: string;
	pushRef?: string;
	userId?: string;
	projectId?: string;
	retryOf?: string;
	rootExecutionMode?: WorkflowExecuteMode;
	executionTimeoutTimestamp?: number;
	suppressErrorWorkflow?: boolean;
	/** Present for webhook, trigger and resumed runs: run this state as is. */
	executionData?: IRunExecutionData;
	/** Manual runs */
	runData?: IRunData;
	pinData?: IPinData;
	startNodes?: StartNodeData[];
	destinationNode?: IDestinationNode;
	triggerToStartFrom?: { name: string; data?: ITaskData };
	dirtyNodeNames?: string[];
	agentRequest?: IDataObject;
}

const ERROR_TRIGGER_TYPE = 'n8n-nodes-base.errorTrigger';
const TERMINAL_STATUSES: ExecutionStatus[] = ['success', 'error', 'canceled', 'crashed'];

const STARTING_NODES = [
	'@n8n/n8n-nodes-langchain.manualChatTrigger',
	'n8n-nodes-base.start',
	'n8n-nodes-base.manualTrigger',
];

function getItemCountByConnectionType(data: ITaskData['data']) {
	const counts: Partial<Record<NodeConnectionType, number[]>> = {};
	for (const [connectionType, connectionData] of Object.entries(data ?? {})) {
		if (!isNodeConnectionType(connectionType)) continue;
		counts[connectionType] = Array.isArray(connectionData)
			? connectionData.map((d) => (d ? d.length : 0))
			: [0];
	}
	return counts;
}

export function determineFinalExecutionStatus(run: IRun): ExecutionStatus {
	if (run.waitTill) return 'waiting';
	if (run.status === 'crashed' || run.status === 'canceled') return run.status;
	if (run.status === 'error' || run.data.resultData?.error) return 'error';
	return 'success';
}

function urls(baseUrl: string) {
	return {
		restApiUrl: `${baseUrl}/rest`,
		instanceBaseUrl: `${baseUrl}/`,
		formWaitingBaseUrl: `${baseUrl}/form-waiting`,
		formBaseUrl: `${baseUrl}/form`,
		formTestBaseUrl: `${baseUrl}/form-test`,
		webhookBaseUrl: `${baseUrl}/webhook`,
		webhookWaitingBaseUrl: `${baseUrl}/webhook-waiting`,
		webhookTestBaseUrl: `${baseUrl}/webhook-test`,
		mcpBaseUrl: `${baseUrl}/mcp`,
		mcpTestBaseUrl: `${baseUrl}/mcp-test`,
	};
}

export async function loadVariables(env: Env, projectId?: string): Promise<IDataObject> {
	const { results } = await env.DB.prepare(
		'SELECT key, value FROM variables WHERE projectId IS NULL OR projectId = ? ORDER BY projectId IS NOT NULL',
	)
		.bind(projectId ?? null)
		.all<{ key: string; value: string | null }>();
	return Object.fromEntries(results.map((v) => [v.key, v.value ?? '']));
}

export function workflowFromRow(row: WorkflowRow): IWorkflowBase {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		active: row.active === 1,
		activeVersionId: row.activeVersionId,
		isArchived: row.isArchived === 1,
		nodes: parseJson(row.nodes, []),
		connections: parseJson(row.connections, {}),
		settings: parseJson(row.settings, undefined),
		staticData: parseJson(row.staticData, undefined),
		pinData: parseJson(row.pinData, undefined),
		versionId: row.versionId,
		createdAt: new Date(row.createdAt),
		updatedAt: new Date(row.updatedAt),
	};
}

export async function loadWorkflow(env: Env, id: string): Promise<IWorkflowBase | null> {
	const row = await env.DB.prepare('SELECT * FROM workflow_entity WHERE id = ?')
		.bind(id)
		.first<WorkflowRow>();
	return row ? workflowFromRow(row) : null;
}

function toWorkflow(workflowData: IWorkflowBase) {
	return new Workflow({
		id: workflowData.id,
		name: workflowData.name,
		nodes: workflowData.nodes,
		connections: workflowData.connections,
		active: workflowData.activeVersionId !== null && workflowData.activeVersionId !== undefined,
		nodeTypes,
		staticData: workflowData.staticData,
		settings: workflowData.settings,
		pinData: workflowData.pinData,
	});
}

export async function buildAdditionalData(
	env: Env,
	req: Pick<RunRequest, 'baseUrl' | 'userId' | 'projectId' | 'pushRef'> & {
		executionId?: string;
		workflowId?: string;
	},
): Promise<IWorkflowExecuteAdditionalData> {
	const { pushRef } = req;
	const projectId = req.workflowId ? await owningProject(env, req.workflowId) : req.projectId;
	const additionalData: IWorkflowExecuteAdditionalData = {
		...urls(req.baseUrl),
		currentNodeExecutionIndex: 0,
		credentialsHelper: new CredentialsHelper(env.DB),
		externalSecretsProxy: Container.get(ExternalSecretsProxy),
		executeWorkflow: async (workflowInfo, parentData, options) =>
			await executeSubWorkflow(env, req.baseUrl, workflowInfo, parentData, options),
		getRunExecutionData: async (executionId) => await loadExecutionData(env, executionId),
		getRuntimeCredential: async () => undefined,
		executionId: req.executionId,
		userId: req.userId,
		workflowId: req.workflowId,
		projectId,
		variables: await loadVariables(env, projectId),
		logAiEvent: () => {},
		startRunnerTask,
		getRunnerStatus,
		sendDataToUI: (type, data) => {
			if (pushRef) void pushHub(env).send({ type, data }, pushRef);
		},
	};
	return additionalData;
}

/** Port of the push, status and save hooks in packages/cli/src/execution-lifecycle. */
export function buildHooks(env: Env, req: RunRequest): ExecutionLifecycleHooks {
	const hooks = new ExecutionLifecycleHooks(req.executionMode, req.executionId, req.workflowData);
	const { pushRef, executionId } = req;
	const stub = pushHub(env);
	// Pushes stay in order but never block the engine. The final message waits for the queue.
	let queue: Promise<void> = Promise.resolve();
	const hub = {
		send: (message: PushMessage, ref: string, asBinary = false) => {
			queue = queue
				.then(async () => await stub.send(message, ref, asBinary))
				.catch((error: unknown) => {
					console.error('push failed', error);
				});
			return queue;
		},
	};

	if (pushRef) {
		let sequenceNumber = 0;
		hooks.addHandler('nodeExecuteBefore', async (nodeName, data) => {
			void hub.send(
				{
					type: 'nodeExecuteBefore',
					data: { executionId, nodeName, sequenceNumber: sequenceNumber++, data },
				},
				pushRef,
			);
		});
		hooks.addHandler('nodeExecuteAfter', async (nodeName, data) => {
			const itemCountByConnectionType = getItemCountByConnectionType(data?.data);
			const { data: _, ...taskData } = data;
			void hub.send(
				{
					type: 'nodeExecuteAfter',
					data: {
						executionId,
						nodeName,
						sequenceNumber: sequenceNumber++,
						itemCountByConnectionType,
						data: taskData,
					},
				},
				pushRef,
			);
			void hub.send(
				{
					type: 'nodeExecuteAfterData',
					data: { executionId, nodeName, itemCountByConnectionType, data },
				},
				pushRef,
				true,
			);
		});
		hooks.addHandler('workflowExecuteBefore', async (_workflow, data) => {
			void hub.send(
				{
					type: 'executionStarted',
					data: {
						executionId,
						mode: req.executionMode,
						startedAt: new Date(),
						retryOf: req.retryOf,
						workflowId: req.workflowData.id,
						workflowName: req.workflowData.name,
						flattedRunData: stringify(data?.resultData.runData ?? {}),
					},
				},
				pushRef,
			);
		});
	}

	hooks.addHandler('workflowExecuteAfter', async (fullRunData, newStaticData) => {
		fullRunData.status = determineFinalExecutionStatus(fullRunData);
		await restoreBinaryDataId(fullRunData, executionId);
		const parent = fullRunData.data.parentExecution;
		if (parent) {
			const runs =
				fullRunData.data.subWorkflowOutput?.lastRunOnly === false
					? getLastExecutedNodeRuns(fullRunData)
					: [getLastExecutedNodeData(fullRunData)];
			for (const output of runs) {
				if (output?.data?.main)
					output.data.main = await Container.get(BinaryDataService).duplicateBinaryData(
						FileLocation.ofExecution(parent.workflowId, parent.executionId),
						output.data.main,
					);
			}
		}

		if (req.executionMode !== 'manual' && newStaticData && req.workflowData.id) {
			await env.DB.prepare('UPDATE workflow_entity SET staticData = ? WHERE id = ?')
				.bind(JSON.stringify(newStaticData), req.workflowData.id)
				.run();
		}

		if (fullRunData.waitTill && pushRef) fullRunData.data.pushRef = pushRef;
		const size = await saveExecutionData(env, executionId, fullRunData.data);
		const waitTill =
			fullRunData.waitTill && fullRunData.waitTill.getTime() < 8e15
				? fullRunData.waitTill.toISOString()
				: null;
		await updateExecution(
			env,
			executionId,
			{
				status: fullRunData.status,
				finished: fullRunData.status === 'success' ? 1 : 0,
				stoppedAt: fullRunData.waitTill
					? null
					: (fullRunData.stoppedAt ?? new Date()).toISOString(),
				waitTill,
				jsonSizeBytes: size,
			},
			{ requireNotCanceled: true },
		);
		if (fullRunData.status === 'success' && req.retryOf) {
			await updateExecution(env, req.retryOf, { retrySuccessId: executionId });
		}

		if (!fullRunData.waitTill && !shouldSaveExecution(req, fullRunData.status, env)) {
			await env.DB.prepare('UPDATE execution_entity SET deletedAt = ? WHERE id = ?')
				.bind(nowIso(), Number(executionId))
				.run();
		}
		if (fullRunData.status !== 'success' && fullRunData.status !== 'waiting')
			await dispatchErrorWorkflow(env, req, fullRunData);

		if (pushRef) {
			const message =
				fullRunData.status === 'waiting'
					? { type: 'executionWaiting', data: { executionId } }
					: {
							type: 'executionFinished',
							data: { executionId, workflowId: req.workflowData.id, status: fullRunData.status },
						};
			await hub.send(message, pushRef);
		}
	});

	const saveProgress = req.workflowData.settings?.saveExecutionProgress;
	if (
		saveProgress === true ||
		((saveProgress ?? 'DEFAULT') === 'DEFAULT' && executionsConfig(env).saveExecutionProgress)
	) {
		hooks.addHandler('nodeExecuteAfter', async (_name, _data, executionData) => {
			await saveExecutionData(env, executionId, executionData);
		});
	}
	return hooks;
}

/** Port of ManualExecutionService.runManually (packages/cli/src/manual-execution.service.ts). */
function runManually(
	req: RunRequest,
	workflow: Workflow,
	additionalData: IWorkflowExecuteAdditionalData,
) {
	if (req.triggerToStartFrom?.data && req.startNodes?.length) {
		const startNodes = req.startNodes.map((startNode) => {
			const node = workflow.getNode(startNode.name);
			a.ok(node, `Could not find a node named "${startNode.name}" in the workflow.`);
			return node;
		});
		const runData = { [req.triggerToStartFrom.name]: [req.triggerToStartFrom.data] };
		let nodeExecutionStack: IExecuteData[] = [];
		let waitingExecution = {};
		let waitingExecutionSource = {};
		if (req.destinationNode?.nodeName !== req.triggerToStartFrom.name) {
			const recreated = recreateNodeExecutionStack(
				filterDisabledNodes(DirectedGraph.fromWorkflow(workflow)),
				new Set(startNodes),
				runData,
				req.pinData ?? {},
			);
			nodeExecutionStack = recreated.nodeExecutionStack;
			waitingExecution = recreated.waitingExecution;
			waitingExecutionSource = recreated.waitingExecutionSource;
		}
		const executionData = createRunExecutionData({
			resultData: { runData, pinData: req.pinData },
			executionData: { nodeExecutionStack, waitingExecution, waitingExecutionSource },
		});
		if (req.destinationNode) executionData.startData = { destinationNode: req.destinationNode };
		return new WorkflowExecute(
			additionalData,
			req.executionMode,
			executionData,
		).processRunExecutionData(workflow);
	}

	if (req.runData === undefined) {
		let startNode;
		if (req.triggerToStartFrom?.name)
			startNode = workflow.getNode(req.triggerToStartFrom.name) ?? undefined;
		if (
			req.startNodes?.length === 1 &&
			Object.keys(req.pinData ?? {}).includes(req.startNodes[0].name)
		) {
			startNode = workflow.getNode(req.startNodes[0].name) ?? undefined;
		}
		return new WorkflowExecute(additionalData, req.executionMode).run({
			workflow,
			startNode,
			destinationNode: req.destinationNode,
			pinData: req.pinData,
			triggerToStartFrom: req.triggerToStartFrom,
		});
	}

	a.ok(req.destinationNode, 'a destinationNodeName is required for the new partial execution flow');
	return new WorkflowExecute(additionalData, req.executionMode).runPartialWorkflow2(
		workflow,
		req.runData,
		req.pinData,
		req.dirtyNodeNames,
		req.destinationNode,
		req.agentRequest as Parameters<WorkflowExecute['runPartialWorkflow2']>[5],
	);
}

/** Runs one execution to its end (or to a wait) in this isolate, with all hooks. */
export interface RunOptions {
	/** Receives the running execution, so the caller can cancel it. */
	onStart?: (execution: { cancel(reason?: string): void }) => void;
	configure?: (data: IWorkflowExecuteAdditionalData) => void;
}

export async function runExecution(
	env: Env,
	req: RunRequest,
	options: RunOptions = {},
): Promise<IRun> {
	await bootstrap(env);
	const hooks = buildHooks(env, req);
	const startTime = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let engineStarted = false;
	try {
		const [, additionalData, marked] = await Promise.all([
			preloadWorkflowTypes(req.workflowData),
			buildAdditionalData(env, { ...req, workflowId: req.workflowData.id }),
			// A resume keeps the start time of the first run, as stock does.
			env.DB.prepare(
				"UPDATE execution_entity SET status = 'running', startedAt = COALESCE(startedAt, ?), waitTill = NULL WHERE id = ? AND status != 'canceled'",
			)
				.bind(nowIso(), Number(req.executionId))
				.run(),
		]);
		// A stop that did not reach this runner already ended the execution. Do not start the engine.
		if (marked.meta.changes === 0) return await canceledBeforeStart(env, req);
		const workflow = toWorkflow(req.workflowData);
		additionalData.hooks = hooks;
		additionalData.rootExecutionMode = req.rootExecutionMode ?? req.executionMode;
		additionalData.executionTimeoutTimestamp = req.executionTimeoutTimestamp;
		options.configure?.(additionalData);

		// Manual runs are checked before they start (runManualExecution). Every other run is checked here.
		if (req.executionMode !== 'manual' && req.workflowData.id) {
			await checkWorkflowCredentials(
				env.DB,
				{ workflowId: req.workflowData.id },
				req.workflowData.nodes,
			);
		}
		const execution = req.executionData
			? new WorkflowExecute(
					additionalData,
					req.executionMode,
					req.executionData,
				).processRunExecutionData(workflow)
			: runManually(req, workflow, additionalData);
		engineStarted = true;
		options.onStart?.(execution);
		if (req.executionTimeoutTimestamp !== undefined) {
			const delay = req.executionTimeoutTimestamp - Date.now();
			if (delay <= 0) execution.cancel('Workflow execution timed out');
			else
				timer = setTimeout(
					() => execution.cancel('Workflow execution timed out'),
					Math.min(delay, 2_147_483_647),
				);
		}
		return await execution;
	} catch (error) {
		if (engineStarted) throw error;
		// Errors before the engine starts (a refused credential, a missing node type) never reach
		// the hooks. Port of WorkflowRunner.failExecution: save a failed run and run the hooks.
		const run = failedRun(req, error, startTime);
		await hooks.runHook('workflowExecuteBefore', [undefined, req.executionData]);
		await hooks.runHook('workflowExecuteAfter', [run]);
		return run;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isExecutionError(error: unknown): error is ExecutionError {
	return (
		error instanceof ExpressionError ||
		error instanceof WorkflowActivationError ||
		error instanceof WorkflowOperationError ||
		error instanceof ExecutionCancelledError ||
		error instanceof NodeOperationError ||
		error instanceof NodeApiError
	);
}

/** Plain copy of an error, so its message and stack survive serialization, as in stock. */
export function toExecutionError(error: unknown): ExecutionError {
	let failure: ExecutionError;
	if (isExecutionError(error)) failure = error;
	else {
		failure = new WorkflowOperationError(error instanceof Error ? error.message : String(error));
		if (error instanceof Error) failure.stack = error.stack;
	}
	return { ...failure, name: failure.name, message: failure.message, stack: failure.stack };
}

/** Port of FailedRunFactory.generateFailedExecutionFromError (packages/cli/src/executions). */
function failedRun(req: RunRequest, error: unknown, startTime: number): IRun {
	const executionError = toExecutionError(error);
	const nodeName =
		isRecord(error) && isRecord(error.node) && typeof error.node.name === 'string'
			? error.node.name
			: undefined;
	const node = req.workflowData.nodes.find((candidate) => candidate.name === nodeName);
	const data = createRunExecutionData({ resultData: { error: executionError, runData: {} } });
	// A failed child or resumed run still belongs to its parent.
	data.parentExecution = req.executionData?.parentExecution;
	if (node) {
		data.startData = {
			destinationNode: { nodeName: node.name, mode: 'inclusive' },
			runNodeFilter: [node.name],
		};
		data.resultData.lastNodeExecuted = node.name;
		data.resultData.runData[node.name] = [
			{
				startTime,
				executionIndex: 0,
				executionTime: 0,
				executionStatus: 'error',
				error: executionError,
				source: [],
			},
		];
		data.executionData = {
			contextData: {},
			metadata: {},
			waitingExecution: {},
			waitingExecutionSource: {},
			nodeExecutionStack: [{ node, data: {}, source: null }],
		};
	}
	return {
		data,
		finished: false,
		mode: req.executionMode,
		startedAt: new Date(startTime),
		stoppedAt: new Date(),
		status: 'error',
		storedAt: 'db',
	};
}

/** Stock stopDuringRun: the stopped execution keeps a cancellation error in its data. */
export function cancellationData(
	executionId: string,
	data: IRunExecutionData = createRunExecutionData(),
): IRunExecutionData {
	data.resultData.error = toExecutionError(new ManualExecutionCancelledError(executionId));
	data.waitTill = undefined;
	return data;
}

async function canceledBeforeStart(env: Env, req: RunRequest): Promise<IRun> {
	const data = cancellationData(req.executionId, createRunExecutionData());
	data.parentExecution = req.executionData?.parentExecution;
	await saveExecutionData(env, req.executionId, data);
	return {
		data,
		finished: false,
		mode: req.executionMode,
		startedAt: new Date(),
		stoppedAt: new Date(),
		status: 'canceled',
		storedAt: 'db',
	};
}

function findSubworkflowStart(workflowData: IWorkflowBase) {
	const trigger = workflowData.nodes.find(
		(node) => node.type === 'n8n-nodes-base.executeWorkflowTrigger',
	);
	if (trigger) return trigger;
	const start = workflowData.nodes.find((node) => STARTING_NODES.includes(node.type));
	if (start) return start;
	throw new UserError('Missing node to start execution', {
		description:
			"Please make sure the workflow you're calling contains an Execute Workflow Trigger node",
	});
}

/** Port of executeWorkflow in packages/cli/src/workflow-execute-additional-data.ts. */
async function executeSubWorkflow(
	env: Env,
	baseUrl: string,
	workflowInfo: IExecuteWorkflowInfo,
	parentData: IWorkflowExecuteAdditionalData,
	options: ExecuteWorkflowOptions,
): Promise<ExecuteWorkflowData> {
	let workflowData = options.loadedWorkflowData;
	if (!workflowData) {
		if (workflowInfo.id !== undefined) {
			const loaded = await loadSubWorkflow(
				env,
				workflowInfo.id,
				parentData.rootExecutionMode ?? options.executionMode ?? 'integrated',
			);
			if (!loaded)
				throw new UnexpectedError('Workflow does not exist.', {
					extra: { workflowId: workflowInfo.id },
				});
			workflowData = loaded;
		} else if (workflowInfo.code !== undefined) {
			workflowData = { ...workflowInfo.code, id: options.parentWorkflowId };
		} else {
			throw new UnexpectedError(
				'No information about the workflow to execute found. Please provide either the "id" or "code"!',
			);
		}
	}
	if (workflowInfo.code) workflowData.settings ??= options.parentWorkflowSettings;

	const executionData =
		options.loadedRunData?.executionData ??
		createRunExecutionData({
			executionData: {
				nodeExecutionStack: [
					{
						node: findSubworkflowStart(workflowData),
						data: { main: [options.inputData ?? [{ json: {} }]] },
						metadata: { parentExecution: options.parentExecution },
						source: null,
					},
				],
			},
			parentExecution: options.parentExecution,
		});
	executionData.subWorkflowOutput ??= getSubWorkflowOutputPolicy(
		workflowData.nodes,
		options.returnLastRunOnly ?? false,
	);

	await checkSubworkflowPolicy(env, workflowData, options.parentWorkflowId, baseUrl, options.node);
	const executionId = await createExecution(env, {
		workflowData,
		mode: 'integrated',
		instanceId: workflowData.id ? `runner:${workflowData.id}` : undefined,
	});
	const childDeadline = executionDeadline(env, workflowData);
	const parentDeadline = options.doNotWaitToFinish
		? undefined
		: parentData.executionTimeoutTimestamp;
	const request: RunRequest = {
		executionId,
		executionMode: 'integrated',
		workflowData,
		baseUrl,
		executionData,
		userId: parentData.userId,
		rootExecutionMode: parentData.rootExecutionMode ?? options.executionMode ?? 'integrated',
		executionTimeoutTimestamp:
			parentDeadline === undefined
				? childDeadline
				: childDeadline === undefined
					? parentDeadline
					: Math.min(parentDeadline, childDeadline),
	};
	const runner = runnerFor(env, workflowData.id ?? executionId);
	if (options.doNotWaitToFinish) {
		await runner.start(executionId, request);
		return { executionId, data: [null] };
	}
	const data = parse(await runner.startAndWait(executionId, request)) as IRun;
	if (data.waitTill) data.waitTill = new Date(data.waitTill);

	if (data.finished === true || data.status === 'waiting') {
		await preloadWorkflowTypes(workflowData);
		const workflow = toWorkflow(workflowData);
		return {
			executionId,
			data: data.data.subWorkflowOutput
				? await collectSubWorkflowOutput(data, workflow, data.data.subWorkflowOutput)
				: legacySubWorkflowOutput(data, workflowData, options.returnLastRunOnly ?? false),
			waitTill: data.waitTill,
		};
	}
	const error = data.data.resultData.error;
	throw Object.assign(new Error(error?.message ?? 'Sub-workflow failed'), error, {
		executionId,
		workflowId: workflowData.id,
	});
}

function legacySubWorkflowOutput(
	data: IRun,
	workflowData: IWorkflowBase,
	callerReturnsLastRunOnly: boolean,
): Array<INodeExecutionData[] | null> {
	const trigger = workflowData.nodes.find(
		(node) => node.type === 'n8n-nodes-base.executeWorkflowTrigger',
	);
	const lastRunOnly =
		callerReturnsLastRunOnly ||
		((trigger?.typeVersion ?? 1) < 1.2 && trigger?.parameters?.returnOutput !== 'allRuns');
	const runs = getLastExecutedNodeRuns(data);
	const { lastNodeExecuted, pinData = {} } = data.data.resultData;
	const manualPinDataOverride =
		data.mode === 'manual' &&
		lastNodeExecuted !== undefined &&
		pinData[lastNodeExecuted] !== undefined;
	if (!lastRunOnly && runs.length > 0 && !manualPinDataOverride) return mergeRunsPerBranch(runs);
	return getLastExecutedNodeData(data)?.data?.main ?? [null];
}

export async function owningProject(env: Env, workflowId: string): Promise<string | undefined> {
	const row = await env.DB.prepare(
		"SELECT projectId FROM shared_workflow WHERE workflowId = ? AND role = 'workflow:owner'",
	)
		.bind(workflowId)
		.first<{ projectId: string }>();
	return row?.projectId;
}

/** The published version of a workflow, or null when the workflow does not exist. */
export async function loadPublishedWorkflow(env: Env, id: string): Promise<IWorkflowBase | null> {
	const workflow = await loadWorkflow(env, id);
	if (!workflow) return null;
	if (!workflow.activeVersionId)
		throw new UserError('Workflow is not active and cannot be executed.');
	const version = await env.DB.prepare(
		'SELECT nodes, connections, versionId FROM workflow_history WHERE workflowId = ? AND versionId = ?',
	)
		.bind(id, workflow.activeVersionId)
		.first<{ nodes: string; connections: string; versionId: string }>();
	if (!version) throw new UserError('Published workflow version does not exist.');
	return {
		...workflow,
		nodes: parseJson(version.nodes, []),
		connections: parseJson(version.connections, {}),
		versionId: version.versionId,
	};
}

/** Stock getDraftWorkflowData and getPublishedWorkflowData: a manual or chat root runs drafts. */
export async function loadSubWorkflow(
	env: Env,
	id: string,
	rootMode: WorkflowExecuteMode,
): Promise<IWorkflowBase | null> {
	return rootMode === 'manual' || rootMode === 'chat'
		? await loadWorkflow(env, id)
		: await loadPublishedWorkflow(env, id);
}

/** Port of SubworkflowPolicyChecker.check (packages/cli/src/executions/pre-execution-checks). */
export async function checkSubworkflowPolicy(
	env: Env,
	workflow: IWorkflowBase,
	parentWorkflowId: string,
	baseUrl: string,
	node?: INode,
): Promise<void> {
	if (!workflow.id) return;
	const policy = workflow.settings?.callerPolicy ?? 'workflowsFromSameOwner';
	if (policy === 'any') return;
	const callerIds =
		workflow.settings?.callerIds
			?.split(',')
			.map((id) => id.trim())
			.filter((id) => id !== '') ?? [];
	if (policy === 'workflowsFromAList' && callerIds.includes(parentWorkflowId)) return;
	if (policy === 'workflowsFromSameOwner') {
		const [parent, child] = await Promise.all([
			owningProject(env, parentWorkflowId),
			owningProject(env, workflow.id),
		]);
		if (parent !== undefined && parent === child) return;
	}
	throw new WorkflowOperationError(
		`The sub-workflow (${workflow.id}) cannot be called by this workflow`,
		node,
		`The sub-workflow you’re trying to execute limits which workflows it can be called by. <a href="${baseUrl}/workflow/${workflow.id}" target="_blank">Update sub-workflow settings</a> to allow other workflows to call it.`,
	);
}

/** Port of determineWorkflowDeadline (packages/cli/src/workflow-execute-additional-data.ts). */
export function executionDeadline(
	env: Env & ExecutionVars,
	workflow: IWorkflowBase,
	startTime = Date.now(),
): number | undefined {
	const config = executionsConfig(env);
	const seconds = workflow.settings?.executionTimeout ?? config.timeout;
	const maximum = config.maxTimeout > 0 ? config.maxTimeout : Infinity;
	return seconds > 0 ? startTime + Math.min(seconds, maximum) * 1000 : undefined;
}

/** Stock save settings: the workflow setting wins, DEFAULT falls back to the instance variable. */
export function shouldSaveExecution(
	req: RunRequest,
	status: ExecutionStatus,
	env: Env & ExecutionVars,
): boolean {
	const config = executionsConfig(env);
	const settings = req.workflowData.settings;
	if (req.executionMode === 'manual') {
		return typeof settings?.saveManualExecutions === 'boolean'
			? settings.saveManualExecutions
			: config.saveDataManualExecutions;
	}
	const value =
		status === 'success' ? settings?.saveDataSuccessExecution : settings?.saveDataErrorExecution;
	const fallback = status === 'success' ? config.saveDataOnSuccess : config.saveDataOnError;
	return (value === undefined || value === 'DEFAULT' ? fallback : value) !== 'none';
}

async function dispatchErrorWorkflow(env: Env, req: RunRequest, run: IRun): Promise<void> {
	const { error, lastNodeExecuted } = run.data.resultData;
	if (req.executionMode === 'manual' || req.suppressErrorWorkflow || !error) return;
	await executeErrorWorkflow(env, {
		workflowData: req.workflowData,
		baseUrl: req.baseUrl,
		mode: req.executionMode,
		error,
		lastNodeExecuted,
		execution: {
			id: req.executionId,
			retryOf: req.retryOf,
			runtimeData: run.data.executionData?.runtimeData,
		},
	});
}

export interface ErrorWorkflowInput {
	workflowData: IWorkflowBase;
	baseUrl: string;
	mode: WorkflowExecuteMode;
	error: ExecutionError;
	lastNodeExecuted?: string;
	/** Not set when a trigger or poller failed before an execution existed. */
	execution?: {
		id: string;
		retryOf?: string;
		runtimeData?: NonNullable<IRunExecutionData['executionData']>['runtimeData'];
	};
}

/** Port of executeErrorWorkflow (packages/cli/src/execution-lifecycle/execute-error-workflow.ts). */
export async function executeErrorWorkflow(env: Env, input: ErrorWorkflowInput): Promise<void> {
	const { workflowData, baseUrl, mode, error, lastNodeExecuted, execution } = input;
	const workflowId = workflowData.id;
	if (!workflowId) return;
	const { errorWorkflow } = workflowData.settings ?? {};
	let id: string | undefined;
	if (errorWorkflow) {
		// An error workflow that fails does not call itself again.
		if (!(mode === 'error' && errorWorkflow === workflowId)) id = errorWorkflow;
	} else if (
		mode !== 'error' &&
		workflowData.nodes.some((node) => node.type === ERROR_TRIGGER_TYPE)
	) {
		id = workflowId;
	}
	if (!id) return;
	try {
		const workflow = await loadPublishedWorkflow(env, id);
		if (!workflow) return;
		try {
			const failedNode = lastNodeExecuted
				? workflowData.nodes.find((node) => node.name === lastNodeExecuted)
				: undefined;
			await checkSubworkflowPolicy(env, workflow, workflowId, baseUrl, failedNode);
		} catch {
			await recordDeniedErrorWorkflow(env, workflow, workflowId);
			return;
		}
		const node = workflow.nodes.findLast((candidate) => candidate.type === ERROR_TRIGGER_TYPE);
		if (!node) return;
		const workflowRef = { id: workflowId, name: workflowData.name };
		const errorData = execution
			? {
					execution: {
						id: execution.id,
						url: `${baseUrl}/workflow/${workflowId}/executions/${execution.id}`,
						error,
						lastNodeExecuted,
						mode,
						retryOf: execution.retryOf,
						executionContext: toErrorWorkflowContext(execution.runtimeData),
					},
					workflow: workflowRef,
				}
			: { trigger: { error, mode }, workflow: workflowRef };
		// Error workflows must not resume the failed parent.
		const parentExecution = execution
			? { executionId: execution.id, workflowId, shouldResume: false }
			: undefined;
		const [executionId, projectId] = await Promise.all([
			createExecution(env, { workflowData: workflow, mode: 'error', instanceId: `runner:${id}` }),
			owningProject(env, id),
		]);
		await runnerFor(env, id).start(executionId, {
			executionId,
			executionMode: 'error',
			workflowData: workflow,
			baseUrl,
			projectId,
			executionData: createRunExecutionData({
				executionData: {
					nodeExecutionStack: [
						{
							node,
							source: null,
							data: { main: [[{ json: errorData }]] },
							metadata: parentExecution ? { parentExecution } : undefined,
						},
					],
				},
				parentExecution,
			}),
		});
	} catch (dispatchError) {
		console.error(
			`Could not execute the error workflow ${id} of workflow ${workflowId}`,
			dispatchError,
		);
	}
}

/** Stock saves a failed execution when the caller policy of the error workflow refuses the call. */
async function recordDeniedErrorWorkflow(
	env: Env,
	workflow: IWorkflowBase,
	callerId: string,
): Promise<void> {
	const node = workflow.nodes.find((candidate) => candidate.type === ERROR_TRIGGER_TYPE);
	if (!node) return;
	const error = new SubworkflowOperationError(
		`Another workflow: (ID ${callerId}) tried to invoke this workflow to handle errors.`,
		"Unfortunately current permissions do not allow this. Please check that this workflow's settings allow it to be called by others",
	);
	const now = new Date();
	const executionId = await createExecution(env, {
		workflowData: workflow,
		mode: 'error',
		status: 'error',
	});
	const data = createRunExecutionData({
		resultData: {
			error,
			lastNodeExecuted: node.name,
			runData: {
				[node.name]: [
					{ startTime: now.getTime(), executionIndex: 0, executionTime: 0, source: [], error },
				],
			},
		},
	});
	const size = await saveExecutionData(env, executionId, data);
	await updateExecution(env, executionId, {
		stoppedAt: now.toISOString(),
		startedAt: now.toISOString(),
		jsonSizeBytes: size,
	});
}

/**
 * Port of updateParentExecutionWithChildResults (packages/cli/src/workflow-helpers.ts). Returns the
 * patched parent data when a finished child of its current wait has a result or an error.
 */
export async function resumeParentData(
	env: Env,
	executionId: string,
): Promise<IRunExecutionData | undefined> {
	const parent = await loadExecutionData(env, executionId);
	const entry = parent?.executionData?.nodeExecutionStack[0];
	if (!parent || !entry || parent.waitReason === 'suspended') return;
	for (const childId of entry.metadata?.waitingChildExecutionIds ?? []) {
		const row = await getExecutionRow(env, childId);
		const status = TERMINAL_STATUSES.find((terminal) => terminal === row?.status);
		if (!row || !status) continue;
		const child = await loadExecutionData(env, childId);
		if (child?.parentExecution?.shouldResume === false) continue;
		const run: IRun = {
			data: child ?? createRunExecutionData(),
			mode: 'integrated',
			startedAt: new Date(row.startedAt ?? row.createdAt),
			status,
			finished: row.finished === 1,
			storedAt: 'db',
		};
		const error = run.data.resultData.error ?? unfinishedChildError(childId, status);
		if (!error && !getLastExecutedNodeData(run)?.data) continue;
		if (error) {
			entry.metadata = {
				...entry.metadata,
				resumeError: error,
				subExecution: { executionId: childId, workflowId: row.workflowId },
			};
		} else {
			const workflow = await loadExecutionWorkflow(env, childId);
			if (!workflow) continue;
			await preloadWorkflowTypes(workflow);
			entry.data = {
				main: run.data.subWorkflowOutput
					? await collectSubWorkflowOutput(run, toWorkflow(workflow), run.data.subWorkflowOutput)
					: (getLastExecutedNodeData(run)?.data?.main ?? [null]),
			};
		}
		await saveExecutionData(env, executionId, parent);
		return parent;
	}
}

/** A canceled or crashed child did not finish. Its parent resumes with an error, not with its partial data. */
function unfinishedChildError(
	childId: string,
	status: ExecutionStatus,
): ExecutionError | undefined {
	if (status === 'canceled') return toExecutionError(new ManualExecutionCancelledError(childId));
	if (status === 'crashed')
		return toExecutionError(
			new WorkflowOperationError(`The sub-workflow execution ${childId} crashed`),
		);
	return undefined;
}
