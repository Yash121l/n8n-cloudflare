/**
 * The boundary between the REST layer and the n8n engine. Route handlers call only these
 * functions, so they never import n8n-core directly.
 */
import { Container } from '@n8n/di';
import { parse } from 'flatted';
import type { Readable } from 'node:stream';
import {
	BinaryDataService,
	Credentials,
	DirectedGraph,
	ExecuteContext,
	LoadOptionsContext,
	LocalLoadOptionsContext,
	RoutingNode,
	anyReachableRootHasRunData,
} from 'n8n-core';
import type {
	ICredentialDataDecryptedObject,
	ICredentialsDecrypted,
	IDataObject,
	IDestinationNode,
	INode,
	INodeCredentialTestResult,
	INodeListSearchResult,
	INodeParameters,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	INodeTypeNameVersion,
	IPinData,
	IRun,
	IRunData,
	IRunExecutionData,
	ILoadOptions,
	INodeCredentials,
	INodeExecutionData,
	ITaskDataConnections,
	IWorkflowBase,
	NodeParameterValueType,
	ResourceMapperFields,
} from 'n8n-workflow';
import {
	NodeHelpers,
	UnexpectedError,
	UserError,
	Workflow,
	createRunExecutionData,
	findDisplayedProperty,
} from 'n8n-workflow';

import { HttpError, badRequest } from '../api/errors';
import type { UserRow } from '../db/types';
import type { Env } from '../env';
import type { RunRequest } from '../execution/runner';
import { recordStoppedWait, runnerFor } from '../execution/execution-runner';
import { buildAdditionalData, loadWorkflow } from '../execution/runner';
import {
	createExecution,
	deleteExecutionsData,
	executionKeys,
	getExecutionRow,
	loadExecutionWorkflow,
	readExecutionDataString,
	updateExecution,
} from '../execution/store';
import { pushHub } from '../push/push-hub';
import * as activation from '../triggers/activation';
import { needsTestWebhook } from '../webhooks/test-webhooks';
import { bootstrap } from './bootstrap';
import {
	CredentialAccessError,
	checkWorkflowCredentials,
	credentialIdsOfRequest,
	findCredentialsUnreadableByUser,
} from './credential-access';
import { CredentialsHelper } from './credentials-helper';
import { testCredentialsWith } from './credentials-tester';
import {
	credentialTypes,
	loadCredentialType,
	loadNodeType,
	nodeTypes,
	preloadWorkflowTypes,
} from './node-types';

/** Body of POST /rest/workflows/:id/run, as sent by the editor. */
export interface ManualRunPayload {
	workflowData: IWorkflowBase;
	runData?: IDataObject;
	startNodes?: Array<{ name: string; sourceData: unknown }>;
	destinationNode?: { nodeName: string; mode: 'inclusive' | 'exclusive' } | string;
	triggerToStartFrom?: { name: string; data?: unknown };
	dirtyNodeNames?: string[];
	agentRequest?: unknown;
	chatSessionId?: string;
}

export interface RunContext {
	env: Env;
	ctx: Pick<ExecutionContext, 'waitUntil'>;
	/** Public origin, e.g. https://n8n.example.workers.dev */
	baseUrl: string;
}

export type ManualRunResult = { executionId: string } | { waitingForWebhook: true };

export interface DynamicParametersRequest {
	/** The user who asks. The request may only name credentials this user can read. Required at run time. */
	user?: UserRow;
	nodeTypeAndVersion: INodeTypeNameVersion;
	path: string;
	currentNodeParameters: INodeParameters;
	credentials?: INodeCredentials;
	methodName?: string;
	loadOptions?: unknown;
	filter?: string;
	paginationToken?: string;
}

/** Body of POST /rest/dynamic-node-parameters/action-result. */
export interface ActionResultRequest extends DynamicParametersRequest {
	handler: string;
	payload?: IDataObject | string;
}

function normalizeDestination(
	destination: ManualRunPayload['destinationNode'],
): IDestinationNode | undefined {
	if (destination === undefined) return undefined;
	return typeof destination === 'string'
		? { nodeName: destination, mode: 'inclusive' }
		: destination;
}

function findPinnedTrigger(
	workflowData: IWorkflowBase,
	destinationNode: string,
	pinData: IPinData,
): INode | undefined {
	const pinnedTriggers = workflowData.nodes
		.filter(
			(node) =>
				!node.disabled &&
				pinData[node.name] &&
				['trigger', 'webhook'].some((suffix) => node.type.toLowerCase().endsWith(suffix)) &&
				node.type !== 'n8n-nodes-base.respondToWebhook',
		)
		.sort((a) => (a.type.endsWith('webhook') ? -1 : 1));
	if (pinnedTriggers.length === 0) return undefined;
	const parents = new Set(
		new Workflow({
			nodes: workflowData.nodes,
			connections: workflowData.connections,
			active: false,
			nodeTypes,
		}).getParentNodes(destinationNode),
	);
	return pinnedTriggers.find((trigger) => parents.has(trigger.name));
}

function isTriggerNode(workflowData: IWorkflowBase, nodeName: string) {
	const node = workflowData.nodes.find((n) => n.name === nodeName);
	if (!node) return false;
	return nodeTypes
		.getByNameAndVersion(node.type, node.typeVersion)
		.description.group.includes('trigger');
}

/** A run that references a credential its workflow cannot use stops before it starts, with the stock message. */
async function assertWorkflowMayUseCredentials(
	env: Env,
	workflowData: IWorkflowBase,
	user: UserRow,
): Promise<void> {
	try {
		await checkWorkflowCredentials(
			env.DB,
			{ workflowId: workflowData.id },
			workflowData.nodes,
			user,
		);
	} catch (error) {
		if (error instanceof CredentialAccessError)
			throw new HttpError(400, error.message, error.description ?? undefined);
		throw error;
	}
}

export const runnerInstanceId = (workflowId: string) => `runner:${workflowId}`;

/**
 * Runs the request in the ExecutionRunner Durable Object of its workflow, which also handles
 * timed waits. Callers that created the row with `runnerInstanceId` skip one D1 write.
 */
export async function startDurableExecution(
	rc: Pick<RunContext, 'env'>,
	request: RunRequest,
	options: { instanceIdSet?: boolean } = {},
): Promise<void> {
	const workflowId = request.workflowData.id ?? request.executionId;
	await Promise.all([
		options.instanceIdSet
			? undefined
			: updateExecution(rc.env, request.executionId, { instanceId: runnerInstanceId(workflowId) }),
		runnerFor(rc.env, workflowId).start(request.executionId, request),
	]);
}

export async function projectIdOfWorkflow(
	env: Env,
	workflowId: string,
): Promise<string | undefined> {
	const row = await env.DB.prepare(
		"SELECT projectId FROM shared_workflow WHERE workflowId = ? AND role = 'workflow:owner'",
	)
		.bind(workflowId)
		.first<{ projectId: string }>();
	return row?.projectId;
}

/** Port of WorkflowExecutionService.executeManually (packages/cli/src/workflows). */
export async function runManualExecution(
	rc: RunContext,
	payload: ManualRunPayload,
	user: UserRow,
	pushRef: string | undefined,
): Promise<ManualRunResult> {
	await bootstrap(rc.env);
	const workflowData: IWorkflowBase = {
		...payload.workflowData,
		active: false,
		activeVersionId: null,
	};
	await preloadWorkflowTypes(workflowData);
	await assertWorkflowMayUseCredentials(rc.env, workflowData, user);

	const destinationNode = normalizeDestination(payload.destinationNode);
	const triggerToStartFrom = payload.triggerToStartFrom as RunRequest['triggerToStartFrom'];
	const runData = triggerToStartFrom ? undefined : (payload.runData as IRunData | undefined);
	const pinData = workflowData.pinData ?? {};
	const agentRequest = payload.agentRequest as IDataObject | undefined;
	const base = {
		executionMode: 'manual' as const,
		workflowData,
		baseUrl: rc.baseUrl,
		pushRef,
		userId: user.id,
		pinData,
	};

	let request: Omit<RunRequest, 'executionId'> | undefined;

	if (runData !== undefined && destinationNode !== undefined) {
		const canRunPartially =
			!isTriggerNode(workflowData, destinationNode.nodeName) &&
			anyReachableRootHasRunData(
				DirectedGraph.fromNodesAndConnections(workflowData.nodes, workflowData.connections),
				destinationNode.nodeName,
				runData,
			);
		if (canRunPartially) {
			request = {
				...base,
				destinationNode,
				runData,
				dirtyNodeNames: payload.dirtyNodeNames,
				agentRequest,
			};
		}
	}

	if (!request && triggerToStartFrom) {
		const needsWebhook =
			(payload.chatSessionId !== undefined || pinData[triggerToStartFrom.name] === undefined) &&
			(await needsTestWebhook(rc, {
				workflowData,
				user,
				pushRef,
				triggerToStartFrom,
				destinationNode,
			}));
		if (needsWebhook) return { waitingForWebhook: true };
		request = { ...base, destinationNode, triggerToStartFrom, agentRequest };
	}

	if (!request && destinationNode) {
		const pinnedTrigger = findPinnedTrigger(workflowData, destinationNode.nodeName, pinData);
		if (
			!pinnedTrigger &&
			(await needsTestWebhook(rc, { workflowData, user, pushRef, destinationNode }))
		) {
			return { waitingForWebhook: true };
		}
		request = {
			...base,
			destinationNode,
			triggerToStartFrom: pinnedTrigger ? { name: pinnedTrigger.name } : undefined,
			agentRequest,
		};
	}

	if (!request)
		throw new UserError('The run request names neither a trigger nor a destination node');

	const [executionId, projectId] = await Promise.all([
		createExecution(rc.env, {
			workflowData,
			mode: 'manual',
			instanceId: workflowData.id ? runnerInstanceId(workflowData.id) : undefined,
			writeSnapshot: false,
		}),
		workflowData.id ? projectIdOfWorkflow(rc.env, workflowData.id) : undefined,
	]);
	await startDurableExecution(
		rc,
		{ ...request, executionId, projectId },
		{ instanceIdSet: workflowData.id !== undefined },
	);
	return { executionId };
}

export async function stopExecution(rc: RunContext, executionId: string): Promise<void> {
	const row = await getExecutionRow(rc.env, executionId);
	if (!row) throw new UserError(`Execution ${executionId} does not exist`);
	if (['success', 'error', 'canceled', 'crashed'].includes(row.status)) return;
	if (row.instanceId?.startsWith('runner:')) {
		await runnerFor(rc.env, row.instanceId.slice('runner:'.length)).cancel(executionId);
	} else if (row.instanceId) {
		try {
			const instance = await rc.env.EXECUTIONS.get(row.instanceId);
			await instance.terminate();
		} catch {
			// The instance already ended.
		}
	}
	await updateExecution(rc.env, executionId, {
		status: 'canceled',
		stoppedAt: new Date().toISOString(),
		waitTill: null,
	});
	if (row.status === 'waiting') await recordStoppedWait(rc.env, executionId);
	await pushHub(rc.env).sendToAll({
		type: 'executionFinished',
		data: { executionId, workflowId: row.workflowId, status: 'canceled' },
	});
}

export interface RetryResult {
	executionId: string;
	run: IRun;
	workflowData: IWorkflowBase;
}

/**
 * Port of ExecutionService.retry (packages/cli/src/executions). Re-runs the stored state of a failed
 * execution as a new execution in mode 'retry' and waits for it to end.
 */
export async function retryExecution(
	rc: RunContext,
	user: UserRow,
	original: { id: string; workflowId: string },
	options: { loadWorkflow?: boolean },
): Promise<RetryResult> {
	await bootstrap(rc.env);
	const stored = await readExecutionDataString(rc.env, original.id);
	const data = stored ? (parse(stored) as IRunExecutionData) : undefined;
	if (!data?.executionData)
		throw badRequest('The execution was aborted before starting, so it cannot be retried');

	let workflowData =
		(await loadExecutionWorkflow(rc.env, original.id)) ??
		(await loadWorkflow(rc.env, original.workflowId));
	if (!workflowData)
		throw badRequest('Workflow could not be found and so the data not be loaded for the retry.');

	const { lastNodeExecuted } = data.resultData;
	if (lastNodeExecuted) {
		delete data.resultData.error;
		const nodeRunData = data.resultData.runData?.[lastNodeExecuted];
		// Only an error run is replaced. After a crash the last run is the success of that node.
		if (
			nodeRunData &&
			nodeRunData.length > 0 &&
			nodeRunData[nodeRunData.length - 1].error !== undefined
		) {
			nodeRunData.pop();
		}
	}

	if (options.loadWorkflow) {
		const current = await loadWorkflow(rc.env, original.workflowId);
		if (!current)
			throw badRequest('Workflow could not be found and so the data not be loaded for the retry.');
		workflowData = current;
		for (const stack of data.executionData.nodeExecutionStack) {
			const node = workflowData.nodes.find((candidate) => candidate.name === stack.node.name);
			if (!node) {
				throw badRequest(
					`Could not find the node "${stack.node.name}" in workflow. It probably got deleted or renamed. Without it the workflow can sadly not be retried.`,
				);
			}
			stack.node = node;
		}
	}
	workflowData = { ...workflowData, active: false, activeVersionId: null };
	await preloadWorkflowTypes(workflowData);

	const workflowId = workflowData.id ?? original.workflowId;
	const [executionId, projectId] = await Promise.all([
		createExecution(rc.env, {
			workflowData,
			mode: 'retry',
			retryOf: original.id,
			instanceId: runnerInstanceId(workflowId),
		}),
		projectIdOfWorkflow(rc.env, workflowId),
	]);
	const request: RunRequest = {
		executionId,
		executionMode: 'retry',
		workflowData,
		baseUrl: rc.baseUrl,
		userId: user.id,
		projectId,
		retryOf: original.id,
		executionData: data,
	};
	const run = parse(await runnerFor(rc.env, workflowId).startAndWait(executionId, request)) as IRun;
	return { executionId, run, workflowData };
}

/** Register webhooks and schedule/poll triggers of a workflow that becomes active. */
export async function activateWorkflow(rc: RunContext, workflowId: string): Promise<void> {
	await activation.activateWorkflow(rc, workflowId);
}

export async function deactivateWorkflow(rc: RunContext, workflowId: string): Promise<void> {
	await activation.deactivateWorkflow(rc, workflowId);
}

/** Same ciphertext format as stock n8n, so exported credentials stay portable. */
export async function encryptCredentialData(
	env: Env,
	data: ICredentialDataDecryptedObject,
): Promise<string> {
	await bootstrap(env);
	const credentials = new Credentials({ id: null, name: '' }, '');
	await credentials.setData(data);
	return credentials.getDataToSave().data ?? '';
}

export async function decryptCredentialData(
	env: Env,
	data: string,
): Promise<ICredentialDataDecryptedObject> {
	await bootstrap(env);
	return await new Credentials({ id: null, name: '' }, '', data).getData();
}

export async function testCredentials(
	rc: RunContext,
	credentials: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
	await bootstrap(rc.env);
	await loadCredentialType(credentials.type);
	const additionalData = await buildAdditionalData(rc.env, { baseUrl: rc.baseUrl });
	const helper = new CredentialsHelper(rc.env.DB);
	return await testCredentialsWith(
		credentials,
		additionalData,
		async (data) =>
			await helper.applyDefaultsAndOverwrites(additionalData, data, credentials.type, 'internal'),
	);
}

/**
 * Properties of a credential type, with the properties of every type in its `extends` chain
 * merged in. Returns an empty array for an unknown type.
 */
export async function getCredentialProperties(type: string): Promise<INodeProperties[]> {
	if (!credentialTypes.recognizes(type)) return [];
	await loadCredentialType(type);
	return CredentialsHelper.credentialsProperties(type);
}

/** Full descriptions for POST /rest/node-types. */
export async function getNodeTypeDescriptions(
	requested: INodeTypeNameVersion[],
): Promise<INodeTypeDescription[]> {
	const descriptions: INodeTypeDescription[] = [];
	for (const { name, version } of requested) {
		try {
			descriptions.push(
				NodeHelpers.getVersionedNodeType(await loadNodeType(name), version).description,
			);
		} catch {
			// Unknown types are left out, like stock n8n.
		}
	}
	return descriptions;
}

async function assertUserMayReadCredentials(
	env: Env,
	user: UserRow | undefined,
	credentials: INodeCredentials | undefined,
) {
	if (!user) throw new UnexpectedError('A dynamic parameters request needs the user who sent it');
	const ids = credentialIdsOfRequest(credentials);
	if ((await findCredentialsUnreadableByUser(env.DB, user, ids)).length > 0)
		throw new HttpError(403, 'Forbidden');
}

async function dynamicContext(rc: RunContext, req: DynamicParametersRequest) {
	await bootstrap(rc.env);
	await assertUserMayReadCredentials(rc.env, req.user, req.credentials);
	const node: INode = {
		parameters: req.currentNodeParameters,
		id: 'uuid-1234',
		name: 'Temp-Node',
		type: req.nodeTypeAndVersion.name,
		typeVersion: req.nodeTypeAndVersion.version,
		position: [0, 0],
		...(req.credentials ? { credentials: req.credentials } : {}),
	};
	await preloadWorkflowTypes({ nodes: [node] });
	const nodeType = nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
	const workflow = new Workflow({ nodes: [node], connections: {}, active: false, nodeTypes });
	const additionalData = await buildAdditionalData(rc.env, {
		baseUrl: rc.baseUrl,
		userId: req.user?.id,
	});
	additionalData.currentNodeParameters = req.currentNodeParameters;
	const context = new LoadOptionsContext(
		workflow,
		workflow.nodes['Temp-Node'],
		additionalData,
		req.path,
	);
	return { nodeType, context, additionalData, workflow };
}

type MethodKind =
	| 'loadOptions'
	| 'listSearch'
	| 'resourceMapping'
	| 'localResourceMapping'
	| 'actionHandler';
type AnyMethod = (this: unknown, ...args: unknown[]) => Promise<unknown>;

function getMethod(nodeType: INodeType, kind: MethodKind, name: string | undefined): AnyMethod {
	const methods: Record<string, unknown> | undefined = nodeType.methods?.[kind];
	const method = name ? methods?.[name] : undefined;
	if (typeof method !== 'function') {
		throw badRequest(
			`Node type "${nodeType.description.name}" has no ${kind} method named "${name}"`,
		);
	}
	return method as AnyMethod;
}

function dedupeFields(fields: ResourceMapperFields): ResourceMapperFields {
	const seen = new Set<string>();
	return {
		...fields,
		fields: fields.fields?.filter((field) => {
			if (seen.has(field.id)) return false;
			seen.add(field.id);
			return true;
		}),
	};
}

/**
 * Port of getOptionsViaLoadOptions. Runs the declarative `routing` of a property through the
 * RoutingNode against a temporary node, like a normal declarative node execution.
 */
async function getOptionsViaRouting(
	{ nodeType, additionalData, workflow }: Awaited<ReturnType<typeof dynamicContext>>,
	routing: ILoadOptions['routing'],
): Promise<INodePropertyOptions[]> {
	if (!nodeType.description.requestDefaults?.baseURL) {
		throw badRequest(
			`Node type "${nodeType.description.name}" does not exist or does not have "requestDefaults.baseURL" defined!`,
		);
	}
	const node = workflow.nodes['Temp-Node'];
	const tempNodeType: INodeType = {
		...nodeType,
		description: {
			...nodeType.description,
			properties: [{ displayName: '', type: 'string', name: '', default: '', routing }],
		},
	};
	const connectionInputData: INodeExecutionData[] = [];
	const inputData: ITaskDataConnections = { main: [[{ json: {} }]] };
	const executeFunctions = new ExecuteContext(
		workflow,
		node,
		additionalData,
		'internal',
		createRunExecutionData({ executionData: { runtimeData: additionalData.executionContext } }),
		0,
		connectionInputData,
		inputData,
		{ node, source: null, data: {} },
		[],
	);
	const optionsData = await new RoutingNode(executeFunctions, tempNodeType).runNode();
	if (optionsData?.length === 0) return [];
	if (!Array.isArray(optionsData)) throw new UnexpectedError('The returned data is not an array');
	return optionsData[0].map((item) => item.json) as unknown as INodePropertyOptions[];
}

/**
 * Port of getOptionsViaMethodName and getOptionsViaLoadOptionsByPath. The routing comes from the
 * node definition at `path`, never from the request body, so a caller cannot send arbitrary requests.
 */
export async function getParameterOptions(
	rc: RunContext,
	req: DynamicParametersRequest,
): Promise<INodePropertyOptions[]> {
	if (!req.methodName && !req.loadOptions) return [];
	const loaded = await dynamicContext(rc, req);
	const { nodeType, context } = loaded;
	if (req.methodName) {
		return (await getMethod(nodeType, 'loadOptions', req.methodName).call(
			context,
		)) as INodePropertyOptions[];
	}
	const { nodeTypeAndVersion, currentNodeParameters, path } = req;
	const property = findDisplayedProperty(
		path,
		nodeType.description.properties,
		currentNodeParameters,
		{ typeVersion: nodeTypeAndVersion.version },
		nodeType.description,
	);
	const routing =
		property && 'typeOptions' in property ? property.typeOptions?.loadOptions?.routing : undefined;
	if (!routing) {
		throw badRequest(
			`Node type "${nodeType.description.name}" has no loadOptions routing for parameter path "${path}"`,
		);
	}
	return await getOptionsViaRouting(loaded, routing);
}

export async function getResourceLocatorResults(
	rc: RunContext,
	req: DynamicParametersRequest,
): Promise<INodeListSearchResult> {
	const { nodeType, context } = await dynamicContext(rc, req);
	const result = (await getMethod(nodeType, 'listSearch', req.methodName).call(
		context,
		req.filter,
		req.paginationToken,
	)) as INodeListSearchResult;
	const token: unknown = result?.paginationToken;
	return typeof token === 'number' ? { ...result, paginationToken: String(token) } : result;
}

export async function getResourceMappingFields(
	rc: RunContext,
	req: DynamicParametersRequest,
): Promise<ResourceMapperFields> {
	const { nodeType, context } = await dynamicContext(rc, req);
	return dedupeFields(
		(await getMethod(nodeType, 'resourceMapping', req.methodName).call(
			context,
		)) as ResourceMapperFields,
	);
}

export async function getLocalResourceMappingFields(
	rc: RunContext,
	req: DynamicParametersRequest,
): Promise<ResourceMapperFields> {
	const { nodeType, additionalData } = await dynamicContext(rc, req);
	const workflowLoader = {
		get: async (workflowId: string) => {
			const workflow = await loadWorkflow(rc.env, workflowId);
			if (!workflow) throw new UserError(`Workflow ${workflowId} does not exist`);
			await preloadWorkflowTypes(workflow);
			return workflow;
		},
	};
	const context = new LocalLoadOptionsContext(nodeTypes, additionalData, req.path, workflowLoader);
	return dedupeFields(
		(await getMethod(nodeType, 'localResourceMapping', req.methodName).call(
			context,
		)) as ResourceMapperFields,
	);
}

export async function getActionResult(
	rc: RunContext,
	req: ActionResultRequest,
): Promise<NodeParameterValueType> {
	const { nodeType, context } = await dynamicContext(rc, req);
	return (await getMethod(nodeType, 'actionHandler', req.handler).call(
		context,
		req.payload,
	)) as NodeParameterValueType;
}

/** The flatted IRunExecutionData string stored in R2, or null. */
export async function readExecutionData(env: Env, executionId: string): Promise<string | null> {
	return await readExecutionDataString(env, executionId);
}

/** The workflow snapshot an execution ran, or null. */
export async function readExecutionWorkflow(
	env: Env,
	executionId: string,
): Promise<IWorkflowBase | null> {
	return await loadExecutionWorkflow(env, executionId);
}

/** Deletes the stored data and binaries of executions. The caller deletes the D1 rows. */
export async function deleteExecutionData(env: Env, executionIds: string[]): Promise<void> {
	await deleteExecutionsData(env, executionIds);
}

/** For GET /rest/binary-data: `binaryDataId` is the `id` field of an IBinaryData, like `s3:workflows/...`. */
export async function readBinaryData(
	env: Env,
	binaryDataId: string,
): Promise<{ data: Buffer; mimeType?: string; fileName?: string; fileSize: number }> {
	await bootstrap(env);
	const service = Container.get(BinaryDataService);
	const [data, metadata] = await Promise.all([
		service.getAsBuffer({ id: binaryDataId, data: '', mimeType: '' }),
		service.getMetadata(binaryDataId),
	]);
	return { data, ...metadata };
}

export interface BinaryMetadata {
	mimeType?: string;
	fileName?: string;
	fileSize?: number;
}

/** Checks a signed token of `createBinarySignedUrl` and returns the binary data id inside. */
export async function validateBinarySignedToken(env: Env, token: string): Promise<string> {
	await bootstrap(env);
	return Container.get(BinaryDataService).validateSignedToken(token);
}

/** Streams a binary from R2 without reading it into memory. Throws FileNotFoundError when it does not exist. */
export async function openBinaryDataStream(
	env: Env,
	binaryDataId: string,
): Promise<{ stream: Readable; metadata: BinaryMetadata }> {
	await bootstrap(env);
	const service = Container.get(BinaryDataService);
	const metadata: BinaryMetadata = await service.getMetadata(binaryDataId).catch(() => ({}));
	return { stream: await service.getAsStream(binaryDataId, STREAM_CHUNK_SIZE), metadata };
}

const STREAM_CHUNK_SIZE = 1024 * 1024;
