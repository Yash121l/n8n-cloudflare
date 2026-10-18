import { parse } from 'flatted';

import type { Session } from '../api/harness';
import { dataOf, recordOf } from '../api/harness';

export const LC = '@n8n/n8n-nodes-langchain.';

export interface TestNode {
	name: string;
	type: string;
	typeVersion: number;
	parameters: Record<string, unknown>;
	credentials?: Record<string, { id: string; name: string }>;
	executeOnce?: boolean;
}

interface TaskData {
	executionStatus?: string;
	error?: { message?: string };
	data?: { main?: Array<Array<{ json: Record<string, unknown> }> | null> };
}

export interface ExecutionResult {
	status: string;
	runData: Record<string, TaskData[]>;
	error?: { message?: string };
	/** `json` of the first output item of a node's last run. */
	output(node: string): Record<string, unknown> | undefined;
}

export async function createCredential(
	session: Session,
	type: string,
	data: Record<string, unknown>,
) {
	const name = `${type} ${crypto.randomUUID()}`;
	const created = await session.post('/rest/credentials', { name, type, data });
	if (created.status !== 200) throw new Error(`credential: ${JSON.stringify(created.body)}`);
	return { [type]: { id: String(recordOf(dataOf(created)).id), name } };
}

/** `to` gets `from` on its input of `type`. */
export function connect(pairs: Array<[from: string, to: string, type?: string]>) {
	const connections: Record<
		string,
		Record<string, Array<Array<{ node: string; type: string; index: number }>>>
	> = {};
	for (const [from, to, type = 'main'] of pairs) {
		const outputs = (connections[from] ??= {});
		(outputs[type] ??= [[]])[0].push({ node: to, type, index: 0 });
	}
	return connections;
}

async function waitForExecution(session: Session, id: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 50_000;
	for (;;) {
		const execution = recordOf(dataOf(await session.get(`/rest/executions/${id}`)));
		if (!['new', 'running', 'waiting'].includes(String(execution.status))) return execution;
		if (Date.now() > deadline)
			throw new Error(`execution ${id} is still ${String(execution.status)}`);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

export async function saveWorkflow(
	session: Session,
	nodes: TestNode[],
	connections: ReturnType<typeof connect>,
): Promise<Record<string, unknown>> {
	const withLayout = nodes.map((node, index) => ({
		id: String(index + 1),
		position: [index * 200, 0],
		...node,
	}));
	const created = await session.post('/rest/workflows', {
		name: `AI ${crypto.randomUUID()}`,
		nodes: withLayout,
		connections,
		settings: { executionOrder: 'v1' },
	});
	if (created.status !== 200) throw new Error(`workflow: ${JSON.stringify(created.body)}`);
	return recordOf(dataOf(created));
}

/** Runs a saved workflow from its manual trigger and reads the finished execution. */
export async function runSavedWorkflow(
	session: Session,
	workflow: Record<string, unknown>,
): Promise<ExecutionResult> {
	const nodes = Array.isArray(workflow.nodes) ? workflow.nodes.map(recordOf) : [];
	const trigger = nodes.find((node) => node.type === 'n8n-nodes-base.manualTrigger');
	const run = await session.post(`/rest/workflows/${String(workflow.id)}/run`, {
		workflowData: workflow,
		triggerToStartFrom: { name: trigger?.name },
	});
	if (run.status !== 200) throw new Error(`run: ${JSON.stringify(run.body)}`);
	const execution = await waitForExecution(session, String(recordOf(dataOf(run)).executionId));
	const data = parse(String(execution.data)) as {
		resultData: { runData: Record<string, TaskData[]>; error?: { message?: string } };
	};
	const { runData, error } = data.resultData;
	return {
		status: String(execution.status),
		runData,
		error,
		output: (node) => runData[node]?.at(-1)?.data?.main?.[0]?.[0]?.json,
	};
}

export async function runWorkflow(
	session: Session,
	nodes: TestNode[],
	connections: ReturnType<typeof connect>,
) {
	return await runSavedWorkflow(session, await saveWorkflow(session, nodes, connections));
}

/** A readable reason for a failed run, for assertion messages. */
export function failureOf(result: ExecutionResult): string {
	const nodeErrors = Object.entries(result.runData).flatMap(([name, runs]) =>
		runs.flatMap((run) => (run.error ? [`${name}: ${run.error.message}`] : [])),
	);
	return JSON.stringify({ status: result.status, error: result.error?.message, nodeErrors });
}
