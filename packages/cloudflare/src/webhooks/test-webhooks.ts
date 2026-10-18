import type { IDestinationNode, ITaskData, IWorkflowBase } from 'n8n-workflow';

import type { UserRow } from '../db/types';
import type { RunContext } from '../runtime/service';
import { buildAdditionalData } from '../execution/runner';
import type { Env } from '../env';
import { bootstrap } from '../runtime/bootstrap';
import { pushHub } from '../push/push-hub';
import { UserError } from 'n8n-workflow';
import { externalWebhook, getWorkflowWebhooks, toWorkflow } from './workflow';

export interface NeedsWebhookParams {
	workflowData: IWorkflowBase;
	user: UserRow;
	pushRef?: string;
	triggerToStartFrom?: { name: string; data?: ITaskData };
	destinationNode?: IDestinationNode;
}

/**
 * Port of TestWebhooks.needsWebhook (packages/cli/src/webhooks/test-webhooks.ts): registers the
 * workflow's webhooks for one test run and returns true when the run must wait for a request.
 */
export async function needsTestWebhook(
	rc: RunContext,
	params: NeedsWebhookParams,
): Promise<boolean> {
	await bootstrap(rc.env);
	if (params.triggerToStartFrom?.data) return false;
	const workflow = await toWorkflow(params.workflowData);
	const additionalData = await buildAdditionalData(rc.env, {
		baseUrl: rc.baseUrl,
		userId: params.user.id,
		pushRef: params.pushRef,
	});
	let webhooks = getWorkflowWebhooks(workflow, additionalData, params.destinationNode, true);
	if (params.triggerToStartFrom)
		webhooks = webhooks.filter((w) => w.node === params.triggerToStartFrom?.name);
	if (!webhooks.length) return false;
	if (!workflow.id) throw new UserError('Save the workflow before listening for a test webhook');
	await cancelTestWebhook(rc.env, workflow.id);
	const expiresAt = new Date(Date.now() + 120_000).toISOString();
	let payload = JSON.stringify({
		workflowData: params.workflowData,
		userId: params.user.id,
		pushRef: params.pushRef,
		destinationNode: params.destinationNode,
		triggerToStartFrom: params.triggerToStartFrom,
		baseUrl: rc.baseUrl,
	});
	const created: typeof webhooks = [];
	try {
		await rc.env.DB.batch(
			webhooks.map((webhook) =>
				rc.env.DB.prepare(
					`INSERT INTO test_webhook (webhookPath, method, workflowId, node, webhookId, pathLength, pushRef, payload, expiresAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(webhookPath, method) DO UPDATE SET
			 workflowId = excluded.workflowId, node = excluded.node, webhookId = excluded.webhookId,
			 pathLength = excluded.pathLength, pushRef = excluded.pushRef, payload = excluded.payload, expiresAt = excluded.expiresAt
			 WHERE test_webhook.expiresAt <= ?`,
				).bind(
					webhook.path,
					webhook.httpMethod,
					workflow.id,
					webhook.node,
					webhook.webhookId ?? null,
					webhook.webhookId ? webhook.path.split('/').length : null,
					params.pushRef ?? null,
					payload,
					expiresAt,
					new Date().toISOString(),
				),
			),
		);
		for (const webhook of webhooks) {
			const row = await rc.env.DB.prepare(
				'SELECT workflowId, payload FROM test_webhook WHERE webhookPath = ? AND method = ?',
			)
				.bind(webhook.path, webhook.httpMethod)
				.first<{ workflowId: string; payload: string }>();
			if (row?.payload !== payload || row.workflowId !== workflow.id)
				throw new UserError(
					`The test webhook "${webhook.httpMethod} ${webhook.path}" is already in use`,
				);
			webhook.isTest = true;
			await externalWebhook(workflow, webhook, 'create', 'manual');
			created.push(webhook);
		}
		const registeredPayload: TestWebhookPayload = JSON.parse(payload);
		registeredPayload.workflowData.staticData = workflow.staticData;
		const updatedPayload = JSON.stringify(registeredPayload);
		await rc.env.DB.prepare(
			'UPDATE test_webhook SET payload = ? WHERE workflowId = ? AND payload = ?',
		)
			.bind(updatedPayload, workflow.id, payload)
			.run();
		payload = updatedPayload;
		await rc.env.TRIGGERS.get(rc.env.TRIGGERS.idFromName(workflow.id)).expireTestWebhooks(
			workflow.id,
			Date.parse(expiresAt),
		);
		return true;
	} catch (error) {
		await rc.env.DB.prepare('DELETE FROM test_webhook WHERE workflowId = ? AND payload = ?')
			.bind(workflow.id, payload)
			.run();
		await Promise.allSettled(
			created.map(async (webhook) => await externalWebhook(workflow, webhook, 'delete', 'manual')),
		);
		throw error;
	}
}

export interface TestWebhookPayload {
	workflowData: IWorkflowBase;
	userId?: string;
	pushRef?: string;
	destinationNode?: IDestinationNode;
	triggerToStartFrom?: NeedsWebhookParams['triggerToStartFrom'];
	baseUrl: string;
}

export async function deleteTestRegistrations(
	env: Env,
	workflowId: string,
	payload?: string,
): Promise<TestWebhookPayload | undefined> {
	const result = await env.DB.prepare(
		`DELETE FROM test_webhook WHERE workflowId = ?${payload ? ' AND payload = ?' : ''} RETURNING payload`,
	)
		.bind(...(payload ? [workflowId, payload] : [workflowId]))
		.all<{ payload: string }>();
	if (!result.results.length) return undefined;
	const data: TestWebhookPayload = JSON.parse(result.results[0].payload);
	const workflow = await toWorkflow(data.workflowData);
	const additionalData = await buildAdditionalData(env, {
		baseUrl: data.baseUrl,
		userId: data.userId,
	});
	const webhooks = getWorkflowWebhooks(workflow, additionalData, data.destinationNode, true).filter(
		(webhook) => !data.triggerToStartFrom || webhook.node === data.triggerToStartFrom.name,
	);
	for (const webhook of webhooks) {
		webhook.isTest = true;
		await externalWebhook(workflow, webhook, 'delete', 'manual');
	}
	return data;
}

export async function cancelTestWebhook(env: Env, workflowId: string): Promise<void> {
	await bootstrap(env);
	const data = await deleteTestRegistrations(env, workflowId);
	if (data?.pushRef)
		await pushHub(env).send({ type: 'testWebhookDeleted', data: { workflowId } }, data.pushRef);
}
