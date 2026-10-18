import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../api/app';

import { buildAdditionalData } from '../execution/runner';
import { pushHub } from '../push/push-hub';
import { bootstrap } from '../runtime/bootstrap';
import type { RunContext } from '../runtime/service';
import { executeWebhook } from './execute';
import { WebhookHttpError } from './request';
import { applySandboxCSP, ResponseCollector } from './response';
import { deleteTestRegistrations } from './test-webhooks';
import type { TestWebhookPayload } from './test-webhooks';
import { handleWaitingWebhook } from './waiting-webhooks';
import { getWorkflowWebhooks, loadActiveWorkflow, toWorkflow } from './workflow';

interface WebhookRow {
	workflowId: string;
	webhookPath: string;
	method: string;
	node: string;
	webhookId: string | null;
	pathLength: number | null;
	payload?: string;
	expiresAt?: string;
}

function segmentsOf(row: WebhookRow) {
	const segments = row.webhookPath.split('/');
	return segments[0] === row.webhookId ? segments.slice(1) : segments;
}

async function matchingRows(rc: RunContext, path: string, test: boolean): Promise<WebhookRow[]> {
	const table = test ? 'test_webhook' : 'webhook_entity';
	const expiry = test ? ' AND expiresAt > ?' : '';
	const now = new Date().toISOString();
	const [webhookId, ...segments] = path.split('/');
	const [staticRows, dynamicRows] = await Promise.all([
		rc.env.DB.prepare(`SELECT * FROM ${table} WHERE webhookPath = ?${expiry}`)
			.bind(...(test ? [path, now] : [path]))
			.all<WebhookRow>(),
		rc.env.DB.prepare(`SELECT * FROM ${table} WHERE webhookId = ? AND pathLength = ?${expiry}`)
			.bind(...(test ? [webhookId, segments.length, now] : [webhookId, segments.length]))
			.all<WebhookRow>(),
	]);
	return [
		...staticRows.results.filter(
			(row) => !row.webhookPath.split('/').some((part) => part.startsWith(':')),
		),
		...dynamicRows.results
			.filter((row) =>
				segmentsOf(row).every((part, i) => part.startsWith(':') || part === segments[i]),
			)
			.sort(
				(a, b) =>
					segmentsOf(b).filter((part) => !part.startsWith(':')).length -
					segmentsOf(a).filter((part) => !part.startsWith(':')).length,
			),
	];
}

export const webhookRoutes = new Hono<AppEnv>();

webhookRoutes.onError((error, c) => {
	const response = c.json(
		{ code: error instanceof WebhookHttpError ? error.status : 500, message: error.message },
		(error instanceof WebhookHttpError ? error.status : 500) as ContentfulStatusCode,
	);
	applySandboxCSP(response.headers, c.req.path.startsWith('/form') ? 'form' : 'webhook');
	return response;
});

for (const prefix of [
	'webhook',
	'webhook-test',
	'form',
	'form-test',
	'webhook-waiting',
	'form-waiting',
]) {
	webhookRoutes.all(`/${prefix}/*`, async (c) => {
		await bootstrap(c.env);
		const request = c.req.raw;
		const url = new URL(request.url);
		const path = decodeURI(url.pathname.slice(prefix.length + 2)).replace(/\/$/, '');
		const rc: RunContext = {
			env: c.env,
			ctx: c.executionCtx,
			baseUrl: (c.env.N8N_EDITOR_BASE_URL ?? url.origin).replace(/\/$/, ''),
		};
		const form = prefix.startsWith('form');
		const response = new ResponseCollector();
		response.locals.webhookSandboxSetting = form ? 'form' : 'webhook';
		if (prefix.endsWith('-waiting'))
			return await handleWaitingWebhook(rc, request, path, form, response);
		const test = prefix.endsWith('-test');
		const rows = await matchingRows(rc, path, test);
		const method =
			request.method === 'OPTIONS'
				? (request.headers.get('access-control-request-method') ?? rows[0]?.method)
				: request.method;
		const row = rows.find((candidate) => candidate.method === method);
		if (!row) {
			const methods = [...new Set(rows.map((candidate) => candidate.method))];
			const suggestion =
				methods.length === 1
					? methods[0]
					: `${methods.slice(0, -1).join(', ')} or ${methods.at(-1)}`;
			return response
				.status(404)
				.json({
					code: 404,
					message: methods.length
						? `This webhook is not registered for ${request.method} requests. Did you mean to make a ${suggestion} request?`
						: `The requested webhook "${request.method} ${path}" is not registered.`,
					hint: test
						? "Click the 'Execute workflow' button on the canvas, then try again. (In test mode, the webhook only works for one call after you click this button)"
						: 'The workflow must be active for a production URL to run successfully.',
				})
				.toResponse(request.method);
		}
		const payload: TestWebhookPayload | undefined = row.payload
			? JSON.parse(row.payload)
			: undefined;
		const data = payload?.workflowData ?? (await loadActiveWorkflow(c.env, row.workflowId));
		const [workflow, additionalData] = await Promise.all([
			toWorkflow(data),
			buildAdditionalData(c.env, {
				baseUrl: rc.baseUrl,
				pushRef: payload?.pushRef,
				userId: payload?.userId,
				workflowId: data.id,
			}),
		]);
		const webhook = getWorkflowWebhooks(workflow, additionalData, undefined, true).find(
			(candidate) =>
				candidate.node === row.node &&
				candidate.httpMethod === method &&
				candidate.path === row.webhookPath,
		);
		if (!webhook || (webhook.webhookDescription.nodeType === 'form') !== form)
			throw new WebhookHttpError(
				404,
				`The requested webhook "${method} ${path}" is not registered.`,
			);
		webhook.isTest = test;
		const node = workflow.getNode(row.node)!;
		const options = node.parameters.options;
		const allowedOrigins =
			options &&
			typeof options === 'object' &&
			'allowedOrigins' in options &&
			typeof options.allowedOrigins === 'string'
				? options.allowedOrigins.split(',').map((origin) => origin.trim())
				: ['*'];
		const origin = request.headers.get('origin');
		if (origin) {
			response.setHeader(
				'access-control-allow-origin',
				allowedOrigins.includes('*') || allowedOrigins.includes(origin)
					? origin
					: allowedOrigins[0],
			);
			response.setHeader('vary', 'Origin');
			response.setHeader(
				'access-control-allow-methods',
				['OPTIONS', ...new Set(rows.map((candidate) => candidate.method))].join(', '),
			);
		}
		if (request.method === 'OPTIONS') {
			response.setHeader('access-control-max-age', '300');
			const headers = request.headers.get('access-control-request-headers');
			if (headers) response.setHeader('access-control-allow-headers', headers);
			return response.status(204).send().toResponse();
		}
		const params: Record<string, string> = {};
		if (row.webhookId) {
			const parts = path.split('/').slice(1);
			segmentsOf(row).forEach((part, index) => {
				if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(parts[index]);
			});
		}
		return await executeWebhook({
			rc,
			request,
			response,
			workflow,
			workflowData: data,
			additionalData,
			webhook,
			params,
			mode: test ? 'manual' : 'webhook',
			pushRef: payload?.pushRef,
			userId: payload?.userId,
			destinationNode: payload?.destinationNode,
			claim: test
				? async () => {
						const deleted = await deleteTestRegistrations(c.env, row.workflowId, row.payload);
						if (!deleted)
							throw new WebhookHttpError(
								409,
								'This test webhook has already been received or canceled',
							);
					}
				: undefined,
			onStarted:
				test && payload?.pushRef
					? async (executionId) => {
							await pushHub(c.env).send(
								{ type: 'testWebhookReceived', data: { workflowId: row.workflowId, executionId } },
								payload.pushRef!,
							);
						}
					: undefined,
		});
	});
}
