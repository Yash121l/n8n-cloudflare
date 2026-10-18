import type { INode, IRunExecutionData } from 'n8n-workflow';
import { expect } from 'vitest';

import type { Instance } from '../api/harness';

export interface ConnectionState {
	configured: boolean;
	connected: boolean;
	failures: number;
	alarm: number | null;
	emitted: number;
	lastError?: string;
}

/** A node with a credential of `credentialType` whose id is `credentialId`. */
export function withCredential(node: INode, credentialType: string, credentialId: string): INode {
	return { ...node, credentials: { [credentialType]: { id: credentialId, name: credentialId } } };
}

export async function storeCredential(
	instance: Instance,
	workflowId: string,
	id: string,
	type: string,
	data: Record<string, unknown>,
): Promise<void> {
	const response = await instance.worker.fetch(`${instance.origin}/__test/credential`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ id, type, data, workflowId }),
	});
	expect(response.status).toBe(200);
	await response.arrayBuffer();
}

export async function connectionState(
	instance: Instance,
	workflowId: string,
	node: string,
): Promise<ConnectionState> {
	const response = await instance.worker.fetch(
		`${instance.origin}/__test/connection/${workflowId}/${encodeURIComponent(node)}`,
	);
	return (await response.json()) as ConnectionState;
}

export async function connectionAction(
	instance: Instance,
	workflowId: string,
	node: string,
	action: 'fire-alarm' | 'evict',
): Promise<void> {
	const response = await instance.worker.fetch(
		`${instance.origin}/__test/connection/${workflowId}/${encodeURIComponent(node)}/${action}`,
		{ method: 'POST' },
	);
	await response.arrayBuffer();
}

export async function deactivate(instance: Instance, workflowId: string): Promise<void> {
	const response = await instance.worker.fetch(
		`${instance.origin}/__test/deactivate/${workflowId}`,
		{
			method: 'POST',
		},
	);
	expect(response.status).toBe(200);
	await response.arrayBuffer();
}

export async function tryActivate(
	instance: Instance,
	workflowId: string,
): Promise<{ status: number; body: { message?: string; active?: boolean } }> {
	const response = await instance.worker.fetch(`${instance.origin}/__test/activate/${workflowId}`, {
		method: 'POST',
	});
	return { status: response.status, body: (await response.json()) as { message?: string } };
}

export async function executionData(
	instance: Instance,
	executionId: unknown,
): Promise<IRunExecutionData> {
	const response = await instance.worker.fetch(
		`${instance.origin}/__test/data/${String(executionId)}`,
	);
	return (await response.json()) as IRunExecutionData;
}

/** JSON of the items that `node` output in an execution. */
export async function outputOf(
	instance: Instance,
	executionId: unknown,
	node: string,
): Promise<unknown[]> {
	const data = await executionData(instance, executionId);
	const runs = data.resultData.runData[node] ?? [];
	return runs.flatMap((run) => (run.data?.main?.[0] ?? []).map((item) => item.json));
}

/** Finished executions of a workflow, oldest first. Read through the worker, which avoids D1 file locks. */
export async function finishedExecutions(
	instance: Instance,
	workflowId: string,
): Promise<Array<Record<string, unknown>>> {
	const response = await instance.worker.fetch(
		`${instance.origin}/__test/executions/${workflowId}`,
	);
	const rows = (await response.json()) as Array<Record<string, unknown>>;
	return rows.filter((row) => row.status === 'success' || row.status === 'error');
}
