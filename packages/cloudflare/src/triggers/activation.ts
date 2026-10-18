import type { RunContext } from '../runtime/service';
import { WorkflowActivationError } from 'n8n-workflow';
import { buildAdditionalData } from '../execution/runner';
import { bootstrap } from '../runtime/bootstrap';
import {
	externalWebhook,
	getWorkflowWebhooks,
	loadActiveWorkflow,
	saveStaticData,
	toWorkflow,
} from '../webhooks/workflow';
import {
	persistentTriggerNodes,
	registerSchedules,
	runPoll,
	validateTriggerTypes,
} from './schedules';
import { triggerConnection } from './trigger-connection';

/** Port of ActiveWorkflowManager.add (packages/cli/src/active-workflow-manager.ts). */
export async function activateWorkflow(rc: RunContext, workflowId: string): Promise<void> {
	await bootstrap(rc.env);
	const data = await loadActiveWorkflow(rc.env, workflowId);
	const workflow = await toWorkflow(data);
	validateTriggerTypes(workflow);
	const additionalData = await buildAdditionalData(rc.env, { baseUrl: rc.baseUrl, workflowId });
	const webhooks = getWorkflowWebhooks(workflow, additionalData, undefined, true);
	const schedules = await registerSchedules(rc, workflow, () => {});
	const persistent = persistentTriggerNodes(workflow);
	if (
		!webhooks.length &&
		!schedules.length &&
		!persistent.length &&
		!data.nodes.some(
			(node) =>
				!node.disabled &&
				['n8n-nodes-base.executeWorkflowTrigger', 'n8n-nodes-base.errorTrigger'].includes(
					node.type,
				),
		)
	)
		throw new WorkflowActivationError(
			'This workflow has no trigger that can be activated. Add a webhook, schedule, polling, or event trigger.',
			{ workflowId },
		);
	const seen = new Map<string, string>();
	for (const webhook of webhooks) {
		const key = `${webhook.httpMethod} ${webhook.path}`;
		const duplicate = seen.get(key);
		if (duplicate && duplicate !== webhook.node)
			throw new WorkflowActivationError(
				`The webhook path "${key}" is used by both "${duplicate}" and "${webhook.node}". Change one webhook path.`,
				{ workflowId },
			);
		seen.set(key, webhook.node);
		const conflict = await rc.env.DB.prepare(
			'SELECT workflowId, node FROM webhook_entity WHERE webhookPath = ? AND method = ?',
		)
			.bind(webhook.path, webhook.httpMethod)
			.first<{ workflowId: string; node: string }>();
		if (conflict && conflict.workflowId !== workflowId)
			throw new WorkflowActivationError(
				`The webhook path "${webhook.httpMethod} ${webhook.path}" is already used by node "${conflict.node}" in workflow "${conflict.workflowId}". Change the webhook path.`,
				{ workflowId },
			);
	}
	const created: typeof webhooks = [];
	const connected: string[] = [];
	let stored = false;
	try {
		const statements = [
			rc.env.DB.prepare('DELETE FROM webhook_entity WHERE workflowId = ?').bind(workflowId),
			...webhooks.map((webhook) =>
				rc.env.DB.prepare(
					'INSERT INTO webhook_entity (workflowId, webhookPath, method, node, webhookId, pathLength) VALUES (?, ?, ?, ?, ?, ?)',
				).bind(
					workflowId,
					webhook.path,
					webhook.httpMethod,
					webhook.node,
					webhook.webhookId ?? null,
					webhook.webhookId ? webhook.path.split('/').length : null,
				),
			),
		];
		await rc.env.DB.batch(statements);
		stored = true;
		for (const webhook of webhooks) {
			await externalWebhook(workflow, webhook, 'create', 'trigger');
			created.push(webhook);
		}
		for (const name of new Set(
			schedules.filter((schedule) => schedule.kind === 'poll').map((schedule) => schedule.node),
		)) {
			await runPoll(rc, workflow, workflow.getNode(name)!);
		}
		await rc.env.TRIGGERS.get(rc.env.TRIGGERS.idFromName(workflowId)).configure(
			JSON.stringify({ ...data, active: true, staticData: workflow.staticData }),
			rc.baseUrl,
			schedules.map(({ callback: _, ...schedule }) => schedule),
		);
		await saveStaticData(rc.env, workflow);
		// Last, so that a trigger which emits at once finds the static data saved above.
		for (const node of persistent) {
			connected.push(node.name);
			await triggerConnection(rc.env, workflowId, node.name).start(
				workflowId,
				node.name,
				rc.baseUrl,
			);
		}
	} catch (cause) {
		if (stored)
			await rc.env.DB.prepare('DELETE FROM webhook_entity WHERE workflowId = ?')
				.bind(workflowId)
				.run();
		await Promise.allSettled([
			...created.map(
				async (webhook) => await externalWebhook(workflow, webhook, 'delete', 'trigger'),
			),
			...connected.map(async (name) => await triggerConnection(rc.env, workflowId, name).stop()),
		]);
		if (stored) await rc.env.TRIGGERS.get(rc.env.TRIGGERS.idFromName(workflowId)).clear();
		throw new WorkflowActivationError(cause instanceof Error ? cause.message : String(cause), {
			workflowId,
		});
	}
}

/** Port of ActiveWorkflowManager.remove. */
export async function deactivateWorkflow(rc: RunContext, workflowId: string): Promise<void> {
	await bootstrap(rc.env);
	const data = await loadActiveWorkflow(rc.env, workflowId);
	const workflow = await toWorkflow(data);
	const additionalData = await buildAdditionalData(rc.env, { baseUrl: rc.baseUrl, workflowId });
	await rc.env.TRIGGERS.get(rc.env.TRIGGERS.idFromName(workflowId)).clear();
	// Runs each node's closeFunction. An object that this misses stops at its next watchdog alarm.
	await Promise.all(
		persistentTriggerNodes(workflow).map(
			async (node) => await triggerConnection(rc.env, workflowId, node.name).stop(),
		),
	);
	for (const webhook of getWorkflowWebhooks(workflow, additionalData, undefined, true))
		await externalWebhook(workflow, webhook, 'delete', 'trigger');
	await rc.env.DB.prepare('DELETE FROM webhook_entity WHERE workflowId = ?').bind(workflowId).run();
	await saveStaticData(rc.env, workflow);
}
