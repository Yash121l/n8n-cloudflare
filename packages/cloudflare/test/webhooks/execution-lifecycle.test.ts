import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IWorkflowBase } from 'n8n-workflow';
import type { Instance } from '../api/harness';
import { startInstance } from '../api/harness';
import { execDb, literal } from '../api/sql';
import {
	activate,
	eventually,
	executions,
	node,
	seed,
	setNode,
	webhookNode,
	workflow,
} from './fixtures';

function published(instance: Instance, data: IWorkflowBase) {
	seed(instance, data);
	execDb(
		instance,
		`INSERT INTO workflow_history (versionId, workflowId, authors, nodes, connections, createdAt, updatedAt) VALUES (${literal(`${data.id}-published`)}, ${literal(data.id!)}, 'test', ${literal(JSON.stringify(data.nodes))}, ${literal(JSON.stringify(data.connections))}, datetime('now'), datetime('now')); UPDATE workflow_entity SET activeVersionId = ${literal(`${data.id}-published`)} WHERE id = ${literal(data.id!)};`,
	);
}

function owned(instance: Instance, workflowId: string, projectId: string) {
	execDb(
		instance,
		`INSERT OR IGNORE INTO project (id, name, type, createdAt, updatedAt) VALUES (${literal(projectId)}, ${literal(projectId)}, 'team', datetime('now'), datetime('now')); INSERT INTO shared_workflow (workflowId, projectId, role, createdAt, updatedAt) VALUES (${literal(workflowId)}, ${literal(projectId)}, 'workflow:owner', datetime('now'), datetime('now'));`,
	);
}

const childTrigger = () =>
	node('Child', 'executeWorkflowTrigger', { inputSource: 'passthrough' }, 1.1);
const call = (id: string) =>
	node(
		'Call',
		'executeWorkflow',
		{
			source: 'database',
			workflowId: { __rl: true, value: id, mode: 'id' },
			mode: 'once',
			options: { waitForSubWorkflow: true },
		},
		1.2,
	);
const waitForWebhook = () =>
	node(
		'Wait',
		'wait',
		{
			resume: 'webhook',
			httpMethod: 'POST',
			responseMode: 'onReceived',
			options: {},
			limitWaitTime: false,
		},
		1.1,
	);
const slow = (origin: string) =>
	node('Slow', 'httpRequest', { url: `${origin}/__test/slow`, options: {} }, 4.2);

interface SavedData {
	resumeToken?: string;
	resultData: {
		runData: Record<
			string,
			Array<{ data?: { main: Array<Array<{ binary?: Record<string, { id?: string }> }>> } }>
		>;
		error?: { message: string };
	};
}

async function savedData(instance: Instance, executionId: unknown): Promise<SavedData> {
	return (await (
		await instance.worker.fetch(`${instance.origin}/__test/data/${executionId}`)
	).json()) as SavedData;
}

describe('execution lifecycle', () => {
	let instance: Instance;
	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('resumes the parent as soon as its webhook-waiting child finishes', async () => {
		const child = workflow('notify-child', [
			childTrigger(),
			waitForWebhook(),
			setNode('child-done'),
		]);
		child.settings = { executionOrder: 'v1', callerPolicy: 'any' };
		published(instance, child);
		await activate(
			instance,
			workflow('notify-parent', [
				webhookNode('notify-parent', 'GET', 'onReceived'),
				call('notify-child'),
				setNode('={{ "parent got " + $json.result }}'),
			]),
		);
		expect((await instance.worker.fetch(`${instance.origin}/webhook/notify-parent`)).status).toBe(
			200,
		);
		await eventually(() =>
			expect(executions(instance, 'notify-parent')[0]?.status).toBe('waiting'),
		);
		const childRow = executions(instance, 'notify-child')[0];
		expect(childRow.status).toBe('waiting');
		const { resumeToken } = await savedData(instance, childRow.id);
		const resumed = await instance.worker.fetch(
			`${instance.origin}/webhook-waiting/${childRow.id}?signature=${resumeToken}`,
			{ method: 'POST' },
		);
		expect(resumed.status).toBe(200);
		// The fallback check runs after 60 seconds. Only the child's notification resumes the parent this fast.
		await eventually(
			() => expect(executions(instance, 'notify-parent')[0].status).toBe('success'),
			10_000,
		);
		expect(
			JSON.stringify(await savedData(instance, executions(instance, 'notify-parent')[0].id)),
		).toContain('parent got child-done');
	});

	it('copies child binaries into the parent execution', async () => {
		const child = workflow('binary-child', [
			childTrigger(),
			node('File', 'convertToFile', { operation: 'toJson', mode: 'once', options: {} }, 1.1),
		]);
		child.settings = { executionOrder: 'v1', callerPolicy: 'any' };
		published(instance, child);
		await activate(
			instance,
			workflow('binary-parent', [
				webhookNode('binary-parent', 'GET', 'onReceived'),
				call('binary-child'),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/binary-parent`);
		await eventually(() =>
			expect(executions(instance, 'binary-parent')[0]?.status).toBe('success'),
		);
		const parentId = String(executions(instance, 'binary-parent')[0].id);
		const childId = String(executions(instance, 'binary-child')[0].id);
		const output = (await savedData(instance, parentId)).resultData.runData.Call[0].data
			?.main[0][0];
		const binaryId = output?.binary?.data?.id;
		expect(binaryId).toContain(`/executions/${parentId}/`);
		expect(binaryId).not.toContain(`/executions/${childId}/`);
	});

	it('stops a running child and ends its parent', async () => {
		const child = workflow('stopped-child', [
			childTrigger(),
			slow(instance.origin),
			setNode('must-not-run'),
		]);
		child.settings = { executionOrder: 'v1', callerPolicy: 'any' };
		published(instance, child);
		await activate(
			instance,
			workflow('stopped-parent', [
				webhookNode('stopped-parent', 'GET', 'onReceived'),
				call('stopped-child'),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/stopped-parent`);
		await eventually(() =>
			expect(executions(instance, 'stopped-child')[0]?.status).toBe('running'),
		);
		const childRow = executions(instance, 'stopped-child')[0];
		expect(childRow.instanceId).toBe('runner:stopped-child');
		expect(
			(
				await instance.worker.fetch(`${instance.origin}/__test/stop/${childRow.id}`, {
					method: 'POST',
				})
			).status,
		).toBe(200);
		// The engine treats the child's cancellation error as a cancellation of the parent, as in stock.
		await eventually(() =>
			expect(executions(instance, 'stopped-parent')[0].status).toBe('canceled'),
		);
		expect(executions(instance, 'stopped-child')[0].status).toBe('canceled');
		expect((await savedData(instance, childRow.id)).resultData.runData).not.toHaveProperty('Set');
	});

	it('allows listed callers and callers from the same project', async () => {
		const listed = workflow('listed-child', [childTrigger(), setNode('listed')]);
		listed.settings = {
			executionOrder: 'v1',
			callerPolicy: 'workflowsFromAList',
			callerIds: 'other, list-parent',
		};
		published(instance, listed);
		await activate(
			instance,
			workflow('list-parent', [webhookNode('list-parent'), call('listed-child')]),
		);
		expect(
			await (await instance.worker.fetch(`${instance.origin}/webhook/list-parent`)).json(),
		).toEqual({ result: 'listed' });

		published(instance, workflow('owned-child', [childTrigger(), setNode('same project')]));
		owned(instance, 'owned-child', 'policy-project');
		await activate(
			instance,
			workflow('owned-parent', [webhookNode('owned-parent'), call('owned-child')]),
		);
		owned(instance, 'owned-parent', 'policy-project');
		expect(
			await (await instance.worker.fetch(`${instance.origin}/webhook/owned-parent`)).json(),
		).toEqual({ result: 'same project' });

		await activate(
			instance,
			workflow('foreign-parent', [webhookNode('foreign-parent'), call('owned-child')]),
		);
		owned(instance, 'foreign-parent', 'other-project');
		expect((await instance.worker.fetch(`${instance.origin}/webhook/foreign-parent`)).status).toBe(
			500,
		);
		expect(executions(instance, 'owned-child')).toHaveLength(1);
	});

	it('starts one execution when a schedule occurrence is handed off twice', async () => {
		seed(
			instance,
			workflow('emit-once', [
				node('Schedule', 'scheduleTrigger', { rule: { interval: [{ field: 'hours' }] } }, 1.2),
				setNode(),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/__test/emit/emit-once`, {
			method: 'POST',
			body: JSON.stringify({ key: 'occurrence:test:0:1' }),
		});
		expect(response.status).toBe(200);
		await eventually(() => expect(executions(instance, 'emit-once')[0]?.status).toBe('success'));
		expect(executions(instance, 'emit-once')).toHaveLength(1);
	});

	it('publishes a workflow with only an Error Trigger', async () => {
		await activate(instance, workflow('only-error-trigger', [node('Error', 'errorTrigger', {})]));
	});

	it('records a failed execution when the error workflow refuses the caller', async () => {
		const handler = workflow('refusing-handler', [node('Error', 'errorTrigger', {}), setNode()]);
		handler.settings = { callerPolicy: 'none' };
		published(instance, handler);
		const failing = workflow('refused-parent', [
			webhookNode('refused-parent'),
			node('Fail', 'stopAndError', { errorType: 'errorMessage', errorMessage: 'parent failed' }),
		]);
		failing.settings = { errorWorkflow: 'refusing-handler' };
		await activate(instance, failing);
		await instance.worker.fetch(`${instance.origin}/webhook/refused-parent`);
		await eventually(() =>
			expect(executions(instance, 'refusing-handler')[0]?.status).toBe('error'),
		);
		const data = await savedData(instance, executions(instance, 'refusing-handler')[0].id);
		expect(data.resultData.error?.message).toBe(
			'Another workflow: (ID refused-parent) tried to invoke this workflow to handle errors.',
		);
		expect(data.resultData.runData).toHaveProperty('Error');
	});

	it('does not time out an execution while it waits', async () => {
		const data = workflow('waiting-timeout', [
			webhookNode('waiting-timeout', 'GET', 'onReceived'),
			waitForWebhook(),
			setNode(),
		]);
		data.settings = { executionOrder: 'v1', executionTimeout: 1 };
		await activate(instance, data);
		await instance.worker.fetch(`${instance.origin}/webhook/waiting-timeout`);
		await eventually(() =>
			expect(executions(instance, 'waiting-timeout')[0]?.status).toBe('waiting'),
		);
		await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(executions(instance, 'waiting-timeout')[0].status).toBe('waiting');
	});

	it('soft-deletes a manual execution when the workflow does not save them', async () => {
		const data = workflow('manual-no-save', [node('Manual', 'manualTrigger', {}), setNode()]);
		data.settings = { executionOrder: 'v1', saveManualExecutions: false };
		seed(instance, data);
		const started = await instance.worker.fetch(`${instance.origin}/__test/run`, {
			method: 'POST',
			body: JSON.stringify({
				workflowData: data,
				executionMode: 'manual',
				destinationNode: { nodeName: 'Set', mode: 'inclusive' },
			}),
		});
		expect(started.status).toBe(200);
		await eventually(() =>
			expect(executions(instance, 'manual-no-save')[0]).toMatchObject({
				status: 'success',
				deletedAt: expect.any(String),
			}),
		);
	});

	it('sets the sandbox CSP on error responses', async () => {
		const missing = await instance.worker.fetch(`${instance.origin}/webhook/not-registered`);
		expect(missing.status).toBe(404);
		expect(missing.headers.get('content-security-policy')).toMatch(/^sandbox /);
		const invalid = await instance.worker.fetch(`${instance.origin}/webhook-waiting/not-a-number`);
		expect(invalid.status).toBe(404);
		expect(invalid.headers.get('content-security-policy')).toMatch(/^sandbox /);
	});

	// Pruning counts every execution of the instance, so this test runs last.
	it('keeps the newest maxCount executions and hard-deletes the rest after the buffer', async () => {
		await activate(instance, workflow('prune-count', [webhookNode('prune-count'), setNode()]));
		for (let index = 0; index < 3; index++)
			await instance.worker.fetch(`${instance.origin}/webhook/prune-count`);
		const rows = executions(instance, 'prune-count');
		expect(rows).toHaveLength(3);
		await instance.worker.fetch(`${instance.origin}/__test/prune`, {
			method: 'POST',
			body: JSON.stringify({ now: Date.now(), maxCount: '1' }),
		});
		const soft = executions(instance, 'prune-count');
		expect(soft.map((row) => row.deletedAt === null)).toEqual([false, false, true]);
		expect(executions(instance, 'notify-parent')[0].deletedAt).not.toBeNull();
		await instance.worker.fetch(`${instance.origin}/__test/prune`, {
			method: 'POST',
			body: JSON.stringify({ now: Date.now() + 2 * 3_600_000, maxCount: '1' }),
		});
		expect(executions(instance, 'prune-count').map((row) => row.id)).toEqual([rows[2].id]);
		expect(
			await (await instance.worker.fetch(`${instance.origin}/__test/data/${rows[0].id}`)).text(),
		).toBe('');
		expect(executions(instance, 'waiting-timeout')[0].status).toBe('waiting');
	});
});
