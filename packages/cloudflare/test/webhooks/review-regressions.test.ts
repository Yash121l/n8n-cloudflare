import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IWorkflowBase } from 'n8n-workflow';
import type { Instance } from '../api/harness';
import { startInstance } from '../api/harness';
import { execDb, literal, queryDb } from '../api/sql';
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

const childTrigger = () =>
	node('Child', 'executeWorkflowTrigger', { inputSource: 'passthrough' }, 1.1);
const call = (id: string, wait = true) =>
	node(
		'Call',
		'executeWorkflow',
		{
			source: 'database',
			workflowId: { __rl: true, value: id, mode: 'id' },
			mode: 'once',
			options: { waitForSubWorkflow: wait },
		},
		1.2,
	);
const slow = (origin: string) =>
	node('Slow', 'httpRequest', { url: `${origin}/__test/slow`, options: {} }, 4.2);
async function requestData(instance: Instance, executionId: unknown) {
	return (await (
		await instance.worker.fetch(`${instance.origin}/__test/data/${executionId}`)
	).json()) as {
		resultData: { runData: Record<string, unknown>; error?: unknown };
		parentExecution?: { executionId: string };
	};
}

describe('review execution regressions', () => {
	let instance: Instance;
	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('publishes a workflow with only an Execute Workflow Trigger', async () => {
		await activate(instance, workflow('only-child', [childTrigger()]));
		expect(
			queryDb(instance, "SELECT * FROM webhook_entity WHERE workflowId = 'only-child'"),
		).toEqual([]);
	});

	it('applies the stock HTML sandbox header after configured response headers', async () => {
		await activate(
			instance,
			workflow('html-sandbox', [
				webhookNode('html-sandbox', 'GET', 'responseNode'),
				node(
					'Respond',
					'respondToWebhook',
					{
						respondWith: 'text',
						responseBody: '<script>document.write("hello")</script>',
						options: {
							responseHeaders: {
								entries: [{ name: 'Content-Security-Policy', value: 'default-src *' }],
							},
						},
					},
					1.4,
				),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/html-sandbox`);
		expect(response.headers.get('content-security-policy')).toMatch(/^sandbox allow-downloads /);
		expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
		expect(await response.text()).toContain('<script>');
	});

	it('returns Respond to Webhook while the runner continues downstream', async () => {
		await activate(
			instance,
			workflow('early-response', [
				webhookNode('early-response', 'GET', 'responseNode'),
				node(
					'Respond',
					'respondToWebhook',
					{ respondWith: 'json', responseBody: '{"early":true}', options: {} },
					1.4,
				),
				slow(instance.origin),
				setNode('finished'),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/early-response`);
		expect(await response.json()).toEqual({ early: true });
		const row = executions(instance, 'early-response')[0];
		expect(row).toMatchObject({ status: 'running', instanceId: 'runner:early-response' });
		await eventually(() =>
			expect(executions(instance, 'early-response')[0].status).toBe('success'),
		);
		expect((await requestData(instance, row.id)).resultData.runData).toHaveProperty('Set');
	});

	it('cancels the webhook engine and prevents downstream nodes', async () => {
		await activate(
			instance,
			workflow('cancel-inline', [
				webhookNode('cancel-inline', 'GET', 'responseNode'),
				node(
					'Respond',
					'respondToWebhook',
					{ respondWith: 'json', responseBody: '{}', options: {} },
					1.4,
				),
				slow(instance.origin),
				setNode('must-not-run'),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/cancel-inline`);
		const row = executions(instance, 'cancel-inline')[0];
		expect(
			(await instance.worker.fetch(`${instance.origin}/__test/stop/${row.id}`, { method: 'POST' }))
				.status,
		).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 2800));
		expect(executions(instance, 'cancel-inline')[0].status).toBe('canceled');
		expect((await requestData(instance, row.id)).resultData.runData).not.toHaveProperty('Set');
	});

	it('loads only global and owning-project variables, with project overrides', async () => {
		execDb(
			instance,
			"INSERT INTO project (id, name, type, createdAt, updatedAt) VALUES ('vars-owner', 'Owner', 'team', datetime('now'), datetime('now')), ('vars-other', 'Other', 'team', datetime('now'), datetime('now')); INSERT INTO variables (id, key, value, projectId) VALUES ('vg', 'shared', 'global', NULL), ('vp', 'shared', 'project', 'vars-owner'), ('vo', 'hidden', 'secret', 'vars-other'), ('vglobal', 'global', 'visible', NULL);",
		);
		const data = workflow('scoped-vars', [
			webhookNode('scoped-vars'),
			setNode('={{ $vars.shared + ":" + $vars.global + ":" + ($vars.hidden || "absent") }}'),
		]);
		seed(instance, data);
		execDb(
			instance,
			"INSERT INTO shared_workflow (workflowId, projectId, role, createdAt, updatedAt) VALUES ('scoped-vars', 'vars-owner', 'workflow:owner', datetime('now'), datetime('now'));",
		);
		await instance.worker.fetch(`${instance.origin}/__test/activate/scoped-vars`, {
			method: 'POST',
		});
		const response = await instance.worker.fetch(`${instance.origin}/webhook/scoped-vars`);
		expect(await response.json()).toEqual({ result: 'project:visible:absent' });
	});

	it('uses the published child in production and the draft for a manual root', async () => {
		const child = workflow('versioned-child', [childTrigger(), setNode('published')]);
		child.settings = { ...child.settings, callerPolicy: 'any' };
		published(instance, child);
		execDb(
			instance,
			`UPDATE workflow_entity SET nodes = ${literal(JSON.stringify([childTrigger(), setNode('draft')]))} WHERE id = 'versioned-child'`,
		);
		await activate(
			instance,
			workflow('version-parent', [webhookNode('version-parent'), call('versioned-child')]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/version-parent`);
		expect(await response.json()).toEqual({ result: 'published' });
		const manual = workflow('draft-parent', [
			node('Manual', 'manualTrigger', {}),
			call('versioned-child'),
		]);
		seed(instance, manual);
		const started = await instance.worker.fetch(`${instance.origin}/__test/run`, {
			method: 'POST',
			body: JSON.stringify({ workflowData: manual, executionMode: 'manual' }),
		});
		expect(started.status).toBe(200);
		await eventually(() => expect(executions(instance, 'draft-parent')[0].status).toBe('success'));
		const childRows = executions(instance, 'versioned-child');
		const childData = await requestData(instance, childRows.at(-1)!.id);
		expect(JSON.stringify(childData)).toContain('draft');
	});

	it('rejects unpublished production children and denied callers', async () => {
		const child = workflow('unpublished-child', [childTrigger(), setNode()]);
		child.settings = { callerPolicy: 'any' };
		seed(instance, child);
		await activate(
			instance,
			workflow('unpublished-parent', [
				webhookNode('unpublished-parent'),
				call('unpublished-child'),
			]),
		);
		expect(
			(await instance.worker.fetch(`${instance.origin}/webhook/unpublished-parent`)).status,
		).toBe(500);
		child.id = 'denied-child';
		child.name = child.id;
		child.settings = { callerPolicy: 'none' };
		published(instance, child);
		await activate(
			instance,
			workflow('denied-parent', [webhookNode('denied-parent'), call('denied-child')]),
		);
		expect((await instance.worker.fetch(`${instance.origin}/webhook/denied-parent`)).status).toBe(
			500,
		);
		expect(executions(instance, 'denied-child')).toHaveLength(0);
	});

	it('resumes a parent after its durable child completes a timed wait', async () => {
		const child = workflow('waiting-child', [
			childTrigger(),
			node('Wait', 'wait', { resume: 'timeInterval', amount: 0.5, unit: 'seconds' }, 1.1),
			setNode('child-finished'),
		]);
		child.settings = { executionOrder: 'v1', callerPolicy: 'any' };
		published(instance, child);
		await activate(
			instance,
			workflow('waiting-parent', [
				webhookNode('waiting-parent'),
				call('waiting-child'),
				setNode('={{ $json.result }}'),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/waiting-parent`);
		await eventually(() =>
			expect(executions(instance, 'waiting-parent')[0].status).toBe('success'),
		);
		const row = executions(instance, 'waiting-child')[0];
		expect(row).toMatchObject({ status: 'success', instanceId: 'runner:waiting-child' });
		const saved = await (
			await instance.worker.fetch(`${instance.origin}/__test/request/${row.id}`)
		).json();
		expect(saved).toMatchObject({ rootExecutionMode: 'webhook' });
		expect(
			JSON.stringify(await requestData(instance, executions(instance, 'waiting-parent')[0].id)),
		).toContain('child-finished');
	});

	it('enforces workflow timeout on active nodes and passes its deadline to children', async () => {
		const child = workflow('timeout-child', [
			childTrigger(),
			slow(instance.origin),
			setNode('must-not-run'),
		]);
		child.settings = { callerPolicy: 'any' };
		published(instance, child);
		const parent = workflow('timeout-parent', [
			webhookNode('timeout-parent', 'GET', 'onReceived'),
			call('timeout-child'),
		]);
		parent.settings = { executionTimeout: 1 };
		await activate(instance, parent);
		await instance.worker.fetch(`${instance.origin}/webhook/timeout-parent`);
		await eventually(() =>
			expect(executions(instance, 'timeout-child')[0]?.status).toBe('canceled'),
		);
		const parentRow = executions(instance, 'timeout-parent')[0];
		const childRow = executions(instance, 'timeout-child')[0];
		const parentRequest = (await (
			await instance.worker.fetch(`${instance.origin}/__test/request/${parentRow.id}`)
		).json()) as Record<string, unknown>;
		const childRequest = (await (
			await instance.worker.fetch(`${instance.origin}/__test/request/${childRow.id}`)
		).json()) as Record<string, unknown>;
		expect(childRequest.executionTimeoutTimestamp).toBe(parentRequest.executionTimeoutTimestamp);
		expect((await requestData(instance, childRow.id)).resultData.runData).not.toHaveProperty('Set');
	});

	it('applies save preferences and prunes D1 plus R2 after the retention buffer', async () => {
		const data = workflow('no-save', [webhookNode('no-save'), setNode()]);
		data.settings = { saveDataSuccessExecution: 'none' };
		await activate(instance, data);
		await instance.worker.fetch(`${instance.origin}/webhook/no-save`);
		const row = executions(instance, 'no-save')[0];
		expect(row.deletedAt).toEqual(expect.any(String));
		await instance.worker.fetch(`${instance.origin}/__test/prune`, {
			method: 'POST',
			body: JSON.stringify({ now: Date.now() + 2 * 3_600_000 }),
		});
		expect(executions(instance, 'no-save')).toEqual([]);
		expect(
			await (await instance.worker.fetch(`${instance.origin}/__test/data/${row.id}`)).text(),
		).toBe('');
	});

	it('dispatches an Error Workflow with parent error data and suppresses self-recursion', async () => {
		const handler = workflow('error-handler', [
			node('Error', 'errorTrigger', {}),
			node('Fail', 'stopAndError', { errorType: 'errorMessage', errorMessage: 'handler failed' }),
		]);
		handler.settings = { callerPolicy: 'any', errorWorkflow: 'error-handler' };
		published(instance, handler);
		const parent = workflow('failing-parent', [
			webhookNode('failing-parent'),
			node('Fail', 'stopAndError', { errorType: 'errorMessage', errorMessage: 'parent failed' }),
		]);
		parent.settings = { errorWorkflow: 'error-handler' };
		await activate(instance, parent);
		await instance.worker.fetch(`${instance.origin}/webhook/failing-parent`);
		await eventually(() => expect(executions(instance, 'error-handler')[0]?.status).toBe('error'));
		const rows = executions(instance, 'error-handler');
		expect(rows).toHaveLength(1);
		const errorData = JSON.stringify(await requestData(instance, rows[0].id));
		expect(errorData).toContain('parent failed');
		expect(errorData).toContain('failing-parent');
	});
});
