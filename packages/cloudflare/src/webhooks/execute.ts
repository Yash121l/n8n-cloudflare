import { readFile } from 'node:fs/promises';
import { Container } from '@n8n/di';
import { BinaryDataService, WebhookContext } from 'n8n-core';
import type {
	IRun,
	IRunExecutionData,
	IWebhookData,
	IWorkflowBase,
	IWorkflowExecuteAdditionalData,
	Workflow,
	WorkflowExecuteMode,
} from 'n8n-workflow';
import {
	CHAT_TRIGGER_NODE_TYPE,
	createRunExecutionData,
	getLastExecutedNodeData,
	isNodeClassInstance,
	MCP_TRIGGER_NODE_TYPE,
	MICROSOFT_AGENT365_TRIGGER_NODE_TYPE,
} from 'n8n-workflow';

import { buildAdditionalData } from '../execution/runner';
import type { RunOptions } from '../execution/runner';
import { CLAIMED_HEADER, EXECUTION_ID_HEADER, runnerFor } from '../execution/execution-runner';
import type { RunRequest } from '../execution/runner';
import { createExecution, executionKeys, updateExecution } from '../execution/store';
import { nodeTypes } from '../runtime/node-types';
import { startDurableExecution } from '../runtime/service';
import type { RunContext } from '../runtime/service';
import { adaptRequest, WebhookHttpError } from './request';
import { ResponseCollector } from './response';
import { descriptionValue, saveStaticData } from './workflow';

interface ExecuteOptions {
	rc: RunContext;
	request: Request;
	response: ResponseCollector;
	workflow: Workflow;
	workflowData: IWorkflowBase;
	/** Built for this workflow by the caller. Without it, one is built here. */
	additionalData?: IWorkflowExecuteAdditionalData;
	webhook: IWebhookData;
	params?: Record<string, string>;
	mode: WorkflowExecuteMode;
	executionId?: string;
	executionData?: IRunExecutionData;
	pushRef?: string;
	userId?: string;
	destinationNode?: RunRequest['destinationNode'];
	claim?: () => Promise<void>;
	onStarted?: (executionId: string) => Promise<void>;
}

export interface WebhookTail {
	responseMode: string;
	form: boolean;
	params?: Record<string, string>;
	statusCode: number;
	headers: Array<[string, string]>;
	fields: Record<string, unknown>;
	/** Body of an onReceived or hostedChat response, sent before the run starts. */
	body?: unknown;
}

/** Triggers that read their execution data while they run, so stock seeds it before the node runs. */
const SEEDED_TRIGGER_TYPES = [
	MCP_TRIGGER_NODE_TYPE,
	MICROSOFT_AGENT365_TRIGGER_NODE_TYPE,
	CHAT_TRIGGER_NODE_TYPE,
];
/** Port of StreamingWebhookResponseHeartbeat (packages/cli/src/webhooks). */
const STREAMING_HEARTBEAT_INTERVAL_MS = 30_000;
const STREAMING_KEEPALIVE_CHUNK = '{"type":"keepalive"}\n';

export async function executeOwnedWebhookTail(
	rc: RunContext,
	request: RunRequest,
	httpRequest: Request,
	runExecution: (options: RunOptions) => Promise<IRun | undefined>,
): Promise<Response> {
	const object = await rc.env.STORAGE.get(executionKeys(request.executionId).webhook);
	if (!object) throw new Error('Webhook response configuration is missing');
	const config = await object.json<WebhookTail>();
	const response = new ResponseCollector();
	response.status(config.statusCode);
	for (const [key, value] of config.headers) response.setHeader(key, value);
	response.locals.webhookSandboxSetting = config.form ? 'form' : 'webhook';
	if (config.responseMode === 'onReceived')
		response.status(Number(config.fields.responseCode ?? config.statusCode)).send(config.body);
	if (config.responseMode === 'hostedChat') response.send(config.body);
	const streaming = config.responseMode === 'streaming';
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	if (streaming) {
		// Edge compression buffers the body. Stock flushes each chunk through its compression instead.
		response.setHeader('content-encoding', 'identity');
		// The trigger sent the stream headers before the run, as in stock.
		response.openStream(() => clearInterval(heartbeat));
		heartbeat = setInterval(() => {
			if (response.writableEnded) clearInterval(heartbeat);
			else response.write(STREAMING_KEEPALIVE_CHUNK);
		}, STREAMING_HEARTBEAT_INTERVAL_MS);
	}
	const adapted = await adaptRequest(httpRequest, config.params, config.form);
	const run = runExecution({
		configure: (additionalData) => {
			additionalData.httpResponse = response.asEngineResponse();
			additionalData.httpRequest = adapted.request;
			if (streaming) {
				// Port of the sendChunk handler of WorkflowRunner.runMainProcess: one JSON line for each chunk.
				additionalData.streamingEnabled = true;
				additionalData.hooks?.addHandler('sendChunk', (chunk) => {
					if (!response.writableEnded) response.write(JSON.stringify(chunk) + '\n');
				});
			}
			additionalData.hooks?.addHandler('sendResponse', async (data) => {
				if (config.responseMode === 'formPage' || streaming) return;
				if (
					config.form &&
					'headers' in data &&
					data.headers &&
					typeof data.headers === 'object' &&
					'location' in data.headers
				) {
					await response.capture({
						body: { redirectURL: data.headers.location },
						headers: {},
						statusCode: 200,
					});
				} else await response.capture(data);
			});
		},
	});
	const finished = run
		.then(async (result) => {
			if (response.writableEnded) return;
			// Stock finalizeExecution ends a streaming response. The engine already sent an error chunk.
			if (streaming) response.end();
			else if (!result || result.data.resultData.error || result.status === 'error') {
				response.status(500).json({ message: 'Error in workflow' });
			} else if (config.responseMode === 'formPage') {
				const url = new URL(`${rc.baseUrl}/form-waiting/${request.executionId}`);
				if (result.data.resumeToken) url.searchParams.set('signature', result.data.resumeToken);
				response.json({ formWaitingUrl: url.toString() });
			} else if (config.responseMode === 'lastNode') {
				await lastNodeResponse(result, response, (key, fallback) => config.fields[key] ?? fallback);
			} else response.send();
		})
		.catch((error: unknown) => {
			if (response.writableEnded) return;
			if (streaming) response.end();
			else
				response
					.status(500)
					.json({ message: error instanceof Error ? error.message : 'Error in workflow' });
		})
		.finally(() => clearInterval(heartbeat));
	rc.ctx.waitUntil(finished);
	if (!streaming) await Promise.race([response.completed, finished]);
	return response.toResponse(httpRequest.method);
}

function property(value: unknown, path: string): unknown {
	return path
		.split('.')
		.reduce<unknown>(
			(current, key) =>
				current && typeof current === 'object' && key in current
					? Reflect.get(current, key)
					: undefined,
			value,
		);
}

export async function executeWebhook(options: ExecuteOptions): Promise<Response> {
	const { rc, workflow, workflowData, webhook, mode, request, response } = options;
	const node = workflow.getNode(webhook.node);
	if (!node) throw new WebhookHttpError(404, 'Could not find node to process webhook.');
	const type = nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
	if (!type.webhook) throw new WebhookHttpError(404, 'Node does not have a webhook method');
	const field = (key: string, fallback?: string | number) =>
		descriptionValue(workflow, node, webhook.webhookDescription, key, fallback);
	let responseMode = String(field('responseMode', 'onReceived'));
	if (node.type === 'n8n-nodes-base.form' && node.parameters.operation === 'completion')
		responseMode = 'onReceived';
	const descendants = workflow.getChildNodes(node.name).map((name) => workflow.nodes[name]);
	const nextForm = descendants.some(
		(child) =>
			!child.disabled &&
			(child.type === 'n8n-nodes-base.form' ||
				(child.type === 'n8n-nodes-base.wait' && child.parameters.resume === 'form')),
	);
	if (request.method === 'POST' && nextForm) {
		if (['n8n-nodes-base.formTrigger', 'n8n-nodes-base.form'].includes(node.type))
			responseMode = 'formPage';
		else if (node.type === 'n8n-nodes-base.wait' && node.parameters.resume === 'form')
			responseMode = 'responseNode';
	}
	// Port of getChatResponseMode: a chat that answers from response nodes is told the run started.
	if (
		node.type === CHAT_TRIGGER_NODE_TYPE &&
		request.method === 'POST' &&
		property(node.parameters, 'options.responseMode') === 'responseNodes'
	)
		responseMode = 'hostedChat';
	if (
		!['onReceived', 'lastNode', 'responseNode', 'formPage', 'streaming', 'hostedChat'].includes(
			responseMode,
		)
	)
		throw new WebhookHttpError(400, `The response mode '${responseMode}' is not valid!`);
	const tailRequest = request.clone();
	const adapted = await adaptRequest(
		request,
		options.params,
		['n8n-nodes-base.formTrigger', 'n8n-nodes-base.form'].includes(node.type),
	);
	const additionalData =
		options.additionalData ??
		(await buildAdditionalData(rc.env, {
			baseUrl: rc.baseUrl,
			pushRef: options.pushRef,
			userId: options.userId,
			executionId: options.executionId,
			workflowId: workflow.id,
		}));
	additionalData.httpRequest = adapted.request;
	additionalData.httpResponse = response.asEngineResponse();
	const closeFunctions: Array<() => Promise<void>> = [];
	const seeded =
		!options.executionData && SEEDED_TRIGGER_TYPES.includes(node.type)
			? createRunExecutionData({
					executionData: { nodeExecutionStack: [{ node, data: { main: [] }, source: null }] },
					...(mode === 'manual' && options.userId
						? { manualData: { userId: options.userId } }
						: {}),
				})
			: undefined;
	const context = new WebhookContext(
		workflow,
		node,
		additionalData,
		mode,
		webhook,
		closeFunctions,
		options.executionData ?? seeded ?? null,
	);
	// Stock copyBinaryFile stores the upload in the binary data store. Uploads here are in memory.
	// Without an execution ID the file goes under `temp`, and restoreBinaryDataId moves it later.
	context.nodeHelpers.copyBinaryFile = async (path, filename, mimeType) => {
		const buffer = adapted.files.get(path) ?? (await readFile(path));
		const binary = await context.helpers.prepareBinaryData(
			buffer,
			filename,
			mimeType ?? 'application/octet-stream',
		);
		binary.fileName = filename;
		return binary;
	};
	let result;
	try {
		result = isNodeClassInstance(type)
			? await type.webhook(context)
			: await type.webhook.call(context);
	} finally {
		for (const close of closeFunctions) await close();
	}
	// Like stock WorkflowStaticDataService, only changed static data is written.
	if (mode !== 'manual' && workflow.staticData.__dataChanged === true) {
		await saveStaticData(rc.env, workflow);
		workflow.staticData.__dataChanged = false;
	}
	if (!result.workflowData) {
		if (!response.writableEnded)
			response
				.status(Number(field('responseCode', 200)))
				.send(result.webhookResponse ?? { message: 'Webhook call received' });
		return response.toResponse(request.method);
	}
	await options.claim?.();
	const executionId =
		options.executionId ??
		(await createExecution(rc.env, {
			workflowData,
			mode,
			instanceId: workflow.id ? `runner:${workflow.id}` : undefined,
			// The runner writes the workflow snapshot itself, off the request path.
			writeSnapshot: false,
		}));
	const seededEntry = seeded?.executionData?.nodeExecutionStack[0];
	if (seededEntry) seededEntry.data.main = result.workflowData;
	const executionData =
		options.executionData ??
		seeded ??
		createRunExecutionData({
			executionData: {
				nodeExecutionStack: [{ node, data: { main: result.workflowData }, source: null }],
			},
			...(mode === 'manual' && options.userId ? { manualData: { userId: options.userId } } : {}),
		});
	if (options.executionData) {
		const entry = executionData.executionData?.nodeExecutionStack[0];
		if (!entry) throw new WebhookHttpError(409, 'Waiting execution has no node to resume');
		entry.node = { ...entry.node, disabled: true };
		entry.data.main = result.workflowData;
		entry.metadata = { ...entry.metadata, forwardAllOutputs: true };
		executionData.waitTill = undefined;
		const previous = executionData.resultData.lastNodeExecuted;
		if (previous) executionData.resultData.runData[previous]?.pop();
	}
	if (options.destinationNode)
		executionData.startData = {
			...executionData.startData,
			destinationNode: options.destinationNode,
		};
	if (mode === 'manual') executionData.resultData.pinData = workflowData.pinData;
	const runRequest: RunRequest = {
		executionId,
		executionMode: mode,
		workflowData: { ...workflowData, staticData: workflow.staticData },
		executionData,
		baseUrl: rc.baseUrl,
		pushRef: options.pushRef,
		userId: options.userId,
		projectId: additionalData.projectId,
	};
	additionalData.executionId = executionId;
	await options.onStarted?.(executionId);
	const code = Number(field('responseCode', 200));
	const headers = node.parameters.options;
	if (headers && typeof headers === 'object' && 'responseHeaders' in headers) {
		const configured = context.getNodeParameter('options.responseHeaders.entries', []) as Array<{
			name: string;
			value: string;
		}>;
		for (const entry of configured) response.setHeader(entry.name, entry.value);
	}
	const configured = field('responseData');
	const onReceivedBody =
		configured === 'noData'
			? undefined
			: configured || result.webhookResponse || { message: 'Workflow was started' };
	// Port of handleHostedChatResponse.
	const hostedChatBody =
		responseMode === 'hostedChat'
			? { executionStarted: true, executionId, resumeToken: executionData.resumeToken }
			: undefined;
	if (responseMode === 'onReceived' && !options.executionId) {
		await startDurableExecution(rc, runRequest, { instanceIdSet: workflow.id !== undefined });
		if (!response.writableEnded) response.status(code).send(onReceivedBody);
		return response.toResponse(request.method);
	}
	if (responseMode === 'hostedChat' && !options.executionId) {
		await startDurableExecution(rc, runRequest, { instanceIdSet: workflow.id !== undefined });
		if (!response.writableEnded) response.send(hostedChatBody);
		return response.toResponse(request.method);
	}
	await Promise.all([
		rc.env.STORAGE.put(executionKeys(executionId).request, JSON.stringify(runRequest)),
		rc.env.STORAGE.put(
			executionKeys(executionId).webhook,
			JSON.stringify({
				responseMode,
				form:
					webhook.webhookDescription.nodeType === 'form' ||
					['n8n-nodes-base.formTrigger', 'n8n-nodes-base.form'].includes(node.type) ||
					node.parameters.resume === 'form',
				params: options.params,
				statusCode: response.statusCode,
				headers: [...response.headers.entries()],
				fields: Object.fromEntries(
					[
						'responseCode',
						'responseData',
						'responseContentType',
						'responsePropertyName',
						'responseBinaryPropertyName',
					].map((key) => [key, field(key)]),
				),
				body: responseMode === 'onReceived' ? onReceivedBody : hostedChatBody,
			} satisfies WebhookTail),
		),
	]);
	const ownedRequest = new Request(tailRequest.url, {
		method: tailRequest.method,
		headers: tailRequest.headers,
		body: tailRequest.body,
		redirect: tailRequest.redirect,
	});
	ownedRequest.headers.set(EXECUTION_ID_HEADER, executionId);
	if (options.executionId) ownedRequest.headers.set(CLAIMED_HEADER, '1');
	return await runnerFor(rc.env, workflow.id ?? executionId).fetch(ownedRequest);
}

async function lastNodeResponse(
	run: IRun,
	response: ResponseCollector,
	field: (key: string, fallback?: string | number) => unknown,
) {
	response.status(Number(field('responseCode', 200)));
	const responseData = field('responseData', 'firstEntryJson');
	if (responseData === 'noData') {
		response.send();
		return;
	}
	const contentType = responseData === 'firstEntryJson' ? field('responseContentType') : undefined;
	if (contentType) response.type(String(contentType));
	const outputs = getLastExecutedNodeData(run)?.data?.main;
	const items = outputs?.[0] ?? [];
	if (!items.length) {
		response.json({
			message: 'Workflow executed successfully but the last node did not return any data',
		});
		return;
	}
	const propertyName = field('responsePropertyName');
	if (responseData === 'firstEntryBinary') {
		const binary = items[0].binary?.[String(field('responseBinaryPropertyName', 'data'))];
		if (!binary) throw new WebhookHttpError(500, 'The last node did not return binary data');
		response.type(binary.mimeType);
		if (binary.fileName)
			response.setHeader(
				'content-disposition',
				`inline; filename*=UTF-8''${encodeURIComponent(binary.fileName)}`,
			);
		// Stored binary data streams from R2. Inline data is in memory already.
		if (binary.id) response.stream(await Container.get(BinaryDataService).getAsStream(binary.id));
		else response.send(await Container.get(BinaryDataService).getAsBuffer(binary));
		return;
	}
	const body =
		responseData === 'allEntries'
			? items.map((item) => item.json)
			: propertyName
				? property(items[0].json, String(propertyName))
				: items[0].json;
	response.send(body);
}
