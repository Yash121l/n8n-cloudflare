import { parse } from 'flatted';

import type { Instance, Session } from '../api/harness';
import { dataOf, recordOf } from '../api/harness';

export interface PushMessage {
	type: string;
	data: Record<string, unknown>;
}

export interface ExecutionData {
	resultData: {
		runData: Record<
			string,
			Array<{
				data?: {
					main: Array<Array<{ json: Record<string, unknown>; binary?: Record<string, unknown> }>>;
				};
			}>
		>;
		metadata?: Record<string, string>;
		error?: { message: string; description?: string | null };
	};
}

export const manualTrigger = {
	id: 'manual',
	name: 'Manual',
	type: 'n8n-nodes-base.manualTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

export function codeNode(name: string, jsCode: string, extra: Record<string, unknown> = {}) {
	const { parameters, ...rest } = extra;
	return {
		id: name,
		name,
		type: 'n8n-nodes-base.code',
		typeVersion: 2,
		position: [200, 0],
		parameters: { jsCode, ...(typeof parameters === 'object' ? parameters : {}) },
		...rest,
	};
}

/** Connects the nodes in a line, in the given order. */
export function chain(...names: string[]) {
	return Object.fromEntries(
		names
			.slice(0, -1)
			.map((name, index) => [
				name,
				{ main: [[{ node: names[index + 1], type: 'main', index: 0 }]] },
			]),
	);
}

export async function createWorkflow(
	session: Session,
	name: string,
	nodes: unknown[],
	connections: Record<string, unknown>,
) {
	const created = await session.post('/rest/workflows', {
		name,
		nodes,
		connections,
		settings: { executionOrder: 'v1' },
	});
	if (created.status !== 200)
		throw new Error(`workflow create failed: ${JSON.stringify(created.body)}`);
	return recordOf(dataOf(created));
}

export async function openPush(instance: Instance, session: Session, pushRef: string) {
	const url = `${instance.origin.replace(/^http/, 'ws')}/rest/push?pushRef=${pushRef}`;
	const socket = new WebSocket(url, {
		headers: { cookie: session.cookieHeader, origin: instance.origin },
	} as unknown as string[]);
	socket.binaryType = 'arraybuffer';
	const messages: PushMessage[] = [];
	socket.addEventListener('message', (event) => {
		const text =
			typeof event.data === 'string'
				? event.data
				: new TextDecoder().decode(event.data as ArrayBuffer);
		messages.push(JSON.parse(text) as PushMessage);
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve());
		socket.addEventListener('error', () => reject(new Error('push socket failed to open')));
	});
	return { socket, messages };
}

/** Starts a manual run from the Manual trigger and waits for it to finish. */
export async function runManually(
	session: Session,
	workflow: Record<string, unknown>,
	pushRef?: string,
) {
	const run = await session.request(
		'POST',
		`/rest/workflows/${String(workflow.id)}/run`,
		{ workflowData: workflow, triggerToStartFrom: { name: 'Manual' } },
		pushRef ? { 'push-ref': pushRef } : {},
	);
	if (run.status !== 200) throw new Error(`run failed: ${JSON.stringify(run.body)}`);
	return await waitForExecution(session, String(recordOf(dataOf(run)).executionId));
}

export async function waitForExecution(session: Session, executionId: string) {
	let execution: Record<string, unknown> = {};
	for (let i = 0; i < 150; i++) {
		execution = recordOf(dataOf(await session.get(`/rest/executions/${executionId}`)));
		if (execution.status === 'success' || execution.status === 'error') break;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return { status: execution.status, data: parse(String(execution.data)) as ExecutionData };
}

/** The `json` of every item the node returned on its first run. */
export function outputOf(data: ExecutionData, node: string) {
	return (data.resultData.runData[node]?.[0]?.data?.main[0] ?? []).map((item) => item.json);
}
