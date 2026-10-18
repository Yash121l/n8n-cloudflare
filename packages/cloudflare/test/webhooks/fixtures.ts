import type { IConnections, INode, IWorkflowBase } from 'n8n-workflow';
import { expect } from 'vitest';
import type { Instance } from '../api/harness';
import { execDb, literal, queryDb } from '../api/sql';

export function node(
	name: string,
	type: string,
	parameters: INode['parameters'],
	typeVersion = 1,
): INode {
	return {
		id: name,
		name,
		type: `n8n-nodes-base.${type}`,
		typeVersion,
		position: [0, 0],
		parameters,
		webhookId: `${name}-webhook`,
	};
}

export function workflow(id: string, nodes: INode[], connections?: IConnections): IWorkflowBase {
	return {
		id,
		name: id,
		active: true,
		isArchived: false,
		activeVersionId: null,
		versionId: 'version-1',
		nodes,
		connections:
			connections ??
			Object.fromEntries(
				nodes
					.slice(0, -1)
					.map((n, index) => [
						n.name,
						{ main: [[{ node: nodes[index + 1].name, type: 'main', index: 0 }]] },
					]),
			),
		settings: { executionOrder: 'v1', timezone: 'UTC' },
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

export function seed(instance: Instance, data: IWorkflowBase) {
	execDb(
		instance,
		`INSERT INTO workflow_entity (id, name, active, nodes, connections, settings, versionId, createdAt, updatedAt)
		VALUES (${literal(data.id!)}, ${literal(data.name)}, 1, ${literal(JSON.stringify(data.nodes))}, ${literal(JSON.stringify(data.connections))},
		${literal(JSON.stringify(data.settings))}, 'version-1', datetime('now'), datetime('now'));`,
	);
}

export function webhookNode(
	path: string,
	method = 'GET',
	responseMode = 'lastNode',
	extra: INode['parameters'] = {},
): INode {
	return node(
		'Webhook',
		'webhook',
		{
			path,
			httpMethod: method,
			responseMode,
			responseData: 'firstEntryJson',
			options: {},
			authentication: 'none',
			...extra,
		},
		2,
	);
}

export function setNode(value = 'worked'): INode {
	return node(
		'Set',
		'set',
		{
			assignments: { assignments: [{ id: 'value', name: 'result', type: 'string', value }] },
			options: {},
		},
		3.4,
	);
}

export async function activate(instance: Instance, data: IWorkflowBase) {
	seed(instance, data);
	const response = await instance.worker.fetch(`${instance.origin}/__test/activate/${data.id}`, {
		method: 'POST',
	});
	expect(await response.json()).toEqual({ active: true });
	expect(response.status).toBe(200);
}

export async function eventually(
	assertion: () => void | Promise<void>,
	timeout = 20_000,
): Promise<void> {
	const until = Date.now() + timeout;
	for (;;) {
		try {
			await assertion();
			return;
		} catch (error) {
			if (Date.now() >= until) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

export function executions(instance: Instance, workflowId: string) {
	return queryDb(
		instance,
		`SELECT * FROM execution_entity WHERE workflowId = ${literal(workflowId)} ORDER BY id`,
	);
}
