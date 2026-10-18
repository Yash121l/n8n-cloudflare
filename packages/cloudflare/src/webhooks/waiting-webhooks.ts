import { timingSafeEqual } from 'node:crypto';
import { Container } from '@n8n/di';
import { InstanceSettings, validateUrlSignature } from 'n8n-core';
import { createRunExecutionData, WAITING_FORMS_EXECUTION_STATUS } from 'n8n-workflow';
import type { WorkflowExecuteMode } from 'n8n-workflow';

import { buildAdditionalData } from '../execution/runner';
import { getExecutionRow, loadExecutionData, loadExecutionWorkflow } from '../execution/store';
import type { RunContext } from '../runtime/service';
import { executeWebhook } from './execute';
import { WebhookHttpError } from './request';
import type { ResponseCollector } from './response';
import { getWorkflowWebhooks, toWorkflow } from './workflow';

function isExecutionMode(mode: string): mode is WorkflowExecuteMode {
	return [
		'cli',
		'error',
		'integrated',
		'internal',
		'manual',
		'retry',
		'trigger',
		'webhook',
		'evaluation',
		'chat',
		'agent',
	].includes(mode);
}

export async function handleWaitingWebhook(
	rc: RunContext,
	request: Request,
	path: string,
	form: boolean,
	response: ResponseCollector,
): Promise<Response> {
	const [executionId, ...suffixParts] = path.split('/');
	if (!/^\d+$/.test(executionId))
		throw new WebhookHttpError(404, `The execution "${executionId}" does not exist.`);
	const row = await getExecutionRow(rc.env, executionId);
	const [data, workflowData] = await Promise.all([
		loadExecutionData(rc.env, executionId),
		loadExecutionWorkflow(rc.env, executionId),
	]);
	if (!row || !data || !workflowData)
		throw new WebhookHttpError(404, `The execution "${executionId}" does not exist.`);
	const url = new URL(request.url);
	let suffix = suffixParts.join('/');
	let token = url.searchParams.get('signature') ?? '';
	if (token.includes('/')) {
		const [value, ...rest] = token.split('/');
		token = value;
		suffix ||= rest.join('/');
		url.searchParams.set('signature', token);
	}
	const sendAndWait = workflowData.nodes.some(
		(node) => node.id === suffix && node.parameters.operation === 'sendAndWait',
	);
	if (data.resumeToken) {
		const provided = Buffer.from(token);
		const stored = Buffer.from(data.resumeToken);
		const valid = sendAndWait
			? validateUrlSignature(token, url, Container.get(InstanceSettings).hmacSignatureSecret)
			: provided.length === stored.length && timingSafeEqual(provided, stored);
		if (!valid) return response.status(401).json({ error: 'Invalid token' }).toResponse();
	}
	url.searchParams.delete('signature');
	const cleanRequest = new Request(url, request);
	if (request.headers.get('origin'))
		response.setHeader('access-control-allow-origin', request.headers.get('origin')!);
	if (request.method === 'OPTIONS') {
		response.setHeader(
			'access-control-allow-methods',
			'OPTIONS, GET, POST, PUT, PATCH, DELETE, HEAD',
		);
		response.setHeader('access-control-max-age', '300');
		response.setHeader(
			'access-control-allow-headers',
			request.headers.get('access-control-request-headers') ?? 'content-type',
		);
		return response.status(204).send().toResponse();
	}
	if (form && suffix === WAITING_FORMS_EXECUTION_STATUS)
		return response.send(row.status === 'waiting' ? 'form-waiting' : row.status).toResponse();
	const workflow = await toWorkflow(workflowData);
	let name = data.resultData.lastNodeExecuted;
	let node = name ? workflow.getNode(name) : null;
	let completedData;
	if (form && row.status === 'success' && request.method === 'GET' && name) {
		const completion = [name, ...workflow.getParentNodes(name).reverse()]
			.map((candidate) => workflow.nodes[candidate])
			.find(
				(candidate) =>
					!candidate.disabled &&
					candidate.type === 'n8n-nodes-base.form' &&
					candidate.parameters.operation === 'completion' &&
					data.resultData.runData[candidate.name]?.length,
			);
		if (completion) {
			name = completion.name;
			node = completion;
			const task = data.resultData.runData[name].at(-1);
			completedData = createRunExecutionData({
				...data,
				executionData: {
					...data.executionData,
					nodeExecutionStack: [
						{ node: completion, data: task?.data ?? { main: [[]] }, source: null },
					],
				},
			});
		}
	}
	if (!node || data.waitReason === 'suspended')
		throw new WebhookHttpError(409, `The execution "${executionId}" is not waiting for a webhook.`);
	const formNode =
		node.type === 'n8n-nodes-base.form' ||
		(node.type === 'n8n-nodes-base.wait' && node.parameters.resume === 'form');
	if (!form && formNode) {
		const redirect = new URL(request.url);
		redirect.pathname = redirect.pathname.replace('/webhook-waiting/', '/form-waiting/');
		return response.redirect(307, redirect.toString()).toResponse();
	}
	if (form && row.status === 'success' && !completedData)
		return response
			.render('form-trigger-completion', {
				title: 'Form Submitted',
				formTitle: 'Form Submitted',
				message: 'Your response has been recorded',
			})
			.toResponse();
	if ((row.status !== 'waiting' && !completedData) || data.resultData.error)
		throw new WebhookHttpError(409, `The execution "${executionId}" is not waiting for a webhook.`);
	const additionalData = await buildAdditionalData(rc.env, {
		baseUrl: rc.baseUrl,
		workflowId: workflow.id,
		executionId,
	});
	const webhook = getWorkflowWebhooks(workflow, additionalData).find(
		(candidate) =>
			candidate.node === name &&
			candidate.httpMethod === request.method &&
			candidate.path === suffix &&
			candidate.webhookDescription.restartWebhook &&
			(candidate.webhookDescription.nodeType === 'form') === form,
	);
	if (!webhook)
		throw new WebhookHttpError(
			404,
			`The workflow for execution "${executionId}" does not contain a waiting webhook with a matching path/method.`,
		);
	if (!isExecutionMode(row.mode))
		throw new WebhookHttpError(
			409,
			`The execution mode "${row.mode}" cannot resume from a webhook`,
		);
	return await executeWebhook({
		rc,
		request: cleanRequest,
		response,
		workflow,
		workflowData,
		webhook,
		mode: row.mode,
		executionId,
		executionData: completedData ?? data,
		pushRef: data.pushRef,
		claim: async () => {
			const result = await rc.env.DB.prepare(
				"UPDATE execution_entity SET status = 'running' WHERE id = ? AND status = 'waiting' RETURNING id",
			)
				.bind(Number(executionId))
				.first();
			if (!result)
				throw new WebhookHttpError(409, `The execution "${executionId}" is running already.`);
		},
	});
}
