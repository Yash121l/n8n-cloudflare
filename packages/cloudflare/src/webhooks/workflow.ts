import { HookContext } from 'n8n-core';
import type {
	IDestinationNode,
	INode,
	IWebhookData,
	IWebhookDescription,
	IWorkflowBase,
	IWorkflowExecuteAdditionalData,
	WorkflowExecuteMode,
} from 'n8n-workflow';
import { NodeHelpers, UserError, Workflow, resolveWebhookDescriptionField } from 'n8n-workflow';

import type { Env } from '../env';
import type { WorkflowRow } from '../db/types';
import { workflowFromRow } from '../execution/runner';
import {
	isKnownNodeType,
	loadNodeType,
	nodeTypes,
	preloadWorkflowTypes,
} from '../runtime/node-types';

export async function loadActiveWorkflow(env: Env, id: string): Promise<IWorkflowBase> {
	const row = await env.DB.prepare(
		`SELECT w.*, h.nodes AS historyNodes, h.connections AS historyConnections, h.versionId AS historyVersionId
		FROM workflow_entity w
		LEFT JOIN workflow_history h ON h.workflowId = w.id AND h.versionId = w.activeVersionId
		WHERE w.id = ?`,
	)
		.bind(id)
		.first<
			WorkflowRow & {
				historyNodes: string | null;
				historyConnections: string | null;
				historyVersionId: string | null;
			}
		>();
	if (!row) throw new UserError(`Could not find workflow with id "${id}"`);
	const data = workflowFromRow(row);
	if (data.activeVersionId) {
		if (
			row.historyNodes === null ||
			row.historyConnections === null ||
			row.historyVersionId === null
		)
			throw new UserError(`Active version not found for workflow with id "${id}"`);
		return {
			...data,
			nodes: JSON.parse(row.historyNodes),
			connections: JSON.parse(row.historyConnections),
			versionId: row.historyVersionId,
		};
	}
	return data;
}

export async function toWorkflow(data: IWorkflowBase): Promise<Workflow> {
	// Dependent node modules can deadlock when workerd evaluates them at the same time.
	for (const type of new Set(data.nodes.map((node) => node.type))) {
		if (isKnownNodeType(type)) await loadNodeType(type);
	}
	await preloadWorkflowTypes(data);
	return new Workflow({
		id: data.id,
		name: data.name,
		nodes: data.nodes,
		connections: data.connections,
		active: data.active,
		nodeTypes,
		settings: data.settings,
		staticData: data.staticData,
		pinData: data.pinData,
	});
}

export function descriptionValue(
	workflow: Workflow,
	node: INode,
	description: IWebhookDescription,
	key: string,
	fallback?: string | boolean | number,
): unknown {
	const native = resolveWebhookDescriptionField(node, description, key);
	if (native.resolved) return native.value ?? fallback;
	return (
		workflow.expression.getSimpleParameterValue(
			node,
			description[key],
			'internal',
			{},
			undefined,
			fallback,
		) ?? fallback
	);
}

export function getWorkflowWebhooks(
	workflow: Workflow,
	additionalData: IWorkflowExecuteAdditionalData,
	destination?: IDestinationNode,
	ignoreRestart = false,
): IWebhookData[] {
	const parents = destination ? new Set(workflow.getParentNodes(destination.nodeName)) : undefined;
	if (destination?.mode === 'inclusive') parents?.add(destination.nodeName);
	const result: IWebhookData[] = [];
	for (const node of Object.values(workflow.nodes)) {
		if (node.disabled || (parents && !parents.has(node.name))) continue;
		const type = nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
		for (const description of type.description.webhooks ?? []) {
			if (ignoreRestart && description.restartWebhook) continue;
			const raw = descriptionValue(workflow, node, description, 'path');
			if (raw === null || raw === undefined) continue;
			const path = NodeHelpers.getNodeWebhookPath(
				workflow.id ?? '__UNSAVED__',
				node,
				String(raw)
					.trim()
					.replace(/^\/|\/$/g, ''),
				Boolean(descriptionValue(workflow, node, description, 'isFullPath', false)),
				Boolean(descriptionValue(workflow, node, description, 'restartWebhook', false)),
			);
			for (const method of String(
				descriptionValue(workflow, node, description, 'httpMethod', 'GET'),
			).split(',')) {
				if (!method.trim()) continue;
				result.push({
					node: node.name,
					path,
					httpMethod: method.trim() as IWebhookData['httpMethod'],
					workflowId: workflow.id ?? '__UNSAVED__',
					webhookDescription: description,
					workflowExecuteAdditionalData: additionalData,
					userId: additionalData.userId,
					webhookId: path.split('/').some((part) => part.startsWith(':'))
						? node.webhookId
						: undefined,
				});
			}
		}
	}
	return result;
}

export async function externalWebhook(
	workflow: Workflow,
	webhook: IWebhookData,
	action: 'create' | 'delete',
	mode: WorkflowExecuteMode,
): Promise<void> {
	const node = workflow.getNode(webhook.node);
	if (!node) throw new UserError(`Could not find webhook node "${webhook.node}"`);
	const type = nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
	const methods = type.webhookMethods?.[webhook.webhookDescription.name];
	if (!methods) return;
	const context = new HookContext(
		workflow,
		node,
		webhook.workflowExecuteAdditionalData,
		mode,
		action === 'create' ? 'activate' : 'update',
		webhook,
	);
	if (action === 'create' && methods.checkExists && (await methods.checkExists.call(context)))
		return;
	await methods[action]?.call(context);
}

export async function saveStaticData(env: Env, workflow: Workflow): Promise<void> {
	if (workflow.id)
		await env.DB.prepare('UPDATE workflow_entity SET staticData = ? WHERE id = ?')
			.bind(JSON.stringify(workflow.staticData), workflow.id)
			.run();
}
