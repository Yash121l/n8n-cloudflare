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
/** Over the 65 seconds below which the Wait node sleeps in memory, so the wait is durable. */
const timedWait = (name = 'Wait', seconds = 70) =>
	node(name, 'wait', { resume: 'timeInterval', amount: seconds, unit: 'seconds' }, 1.1);
const webhookWait = (extra: Record<string, unknown> = {}) =>
	node(
		'Wait',
		'wait',
		{
			resume: 'webhook',
			httpMethod: 'POST',
			responseMode: 'onReceived',
			options: {},
			limitWaitTime: false,
			...extra,
		},
		1.1,
	);
const slow = (origin: string) =>
	node('Slow', 'httpRequest', { url: `${origin}/__test/slow`, options: {} }, 4.2);

interface Probe {
	alarms: number;
	alarm: number | null;
	pending: Record<string, { kind: string; due?: number; attempt?: number }>;
}

interface SavedData {
	resumeToken?: string;
	parentExecution?: { executionId: string };
	resultData: {
		runData: Record<
			string,
			Array<{ data?: { main: Array<Array<{ binary?: Record<string, { id?: string }> }>> } }>
		>;
		error?: { message: string };
	};
}

describe('runner lifecycle', () => {
	let instance: Instance;
	const post = async (path: string, body: unknown = {}) =>
		await instance.worker.fetch(`${instance.origin}${path}`, {
			method: 'POST',
			body: JSON.stringify(body),
		});
	const probe = async (workflowId: string) =>
		(await (
			await instance.worker.fetch(`${instance.origin}/__test/runner/${workflowId}/probe`)
		).json()) as Probe;
	const savedData = async (executionId: unknown) =>
		(await (
			await instance.worker.fetch(`${instance.origin}/__test/data/${executionId}`)
		).json()) as SavedData;
	const statusOf = (workflowId: string) => executions(instance, workflowId)[0]?.status;
	const r2Keys = async (prefix: string) =>
		(await (
			await instance.worker.fetch(
				`${instance.origin}/__test/r2?prefix=${encodeURIComponent(prefix)}`,
			)
		).json()) as string[];

	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('resumes a timed wait from a real alarm without repeating alarms, and keeps startedAt', async () => {
		await activate(
			instance,
			workflow('resume-spin', [
				webhookNode('resume-spin', 'GET', 'onReceived'),
				timedWait(),
				slow(instance.origin),
				setNode('resumed'),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/resume-spin`);
		await eventually(() => expect(statusOf('resume-spin')).toBe('waiting'));
		const row = executions(instance, 'resume-spin')[0];
		const key = `pending:${row.id}`;
		expect((await probe('resume-spin')).pending[key]).toMatchObject({ kind: 'resume' });

		await post('/__test/runner/resume-spin/advance-wait', {
			executionId: String(row.id),
			due: Date.now() + 300,
		});
		await eventually(() => expect(statusOf('resume-spin')).toBe('running'));
		// The claimed resume is accepted work: the watchdog covers it and the past due time is gone.
		expect((await probe('resume-spin')).pending[key]).toEqual({ kind: 'run' });
		await eventually(() => expect(statusOf('resume-spin')).toBe('success'));
		const after = await probe('resume-spin');
		expect(after.alarms).toBeLessThan(5);
		expect(after.pending).toEqual({});
		expect(executions(instance, 'resume-spin')[0].startedAt).toBe(row.startedAt);
		expect((await savedData(row.id)).resultData.runData).toHaveProperty('Set');
	});

	it('keeps a later wait when a stale alarm entry of an earlier wait runs', async () => {
		await activate(
			instance,
			workflow('stale-entry', [
				webhookNode('stale-entry', 'GET', 'onReceived'),
				timedWait('First'),
				timedWait('Second', 80),
				setNode('done'),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/stale-entry`);
		await eventually(() => expect(statusOf('stale-entry')).toBe('waiting'));
		const id = String(executions(instance, 'stale-entry')[0].id);
		const key = `pending:${id}`;
		const firstDue = Date.now() + 300;
		await post('/__test/runner/stale-entry/advance-wait', { executionId: id, due: firstDue });
		await eventually(async () => {
			expect(statusOf('stale-entry')).toBe('waiting');
			expect((await savedData(id)).resultData.runData).toHaveProperty('First');
			expect((await probe('stale-entry')).pending[key]?.due).toBeGreaterThan(firstDue + 60_000);
		});
		const second = (await probe('stale-entry')).pending[key];

		// An alarm that read the first entry before the resume runs it now.
		const stale = await post('/__test/runner/stale-entry/stale-entry', {
			executionId: id,
			entry: { kind: 'resume', due: firstDue },
		});
		expect(stale.status).toBe(200);
		expect(statusOf('stale-entry')).toBe('waiting');
		expect((await savedData(id)).resultData.runData).not.toHaveProperty('Set');
		expect((await probe('stale-entry')).pending[key]).toEqual(second);

		await post('/__test/runner/stale-entry/advance-wait', {
			executionId: id,
			due: Date.now() + 300,
		});
		await eventually(() => expect(statusOf('stale-entry')).toBe('success'));
	});

	it('resumes the parent when its durable child finishes a wait of more than 65 seconds', async () => {
		const child = workflow('durable-child', [
			childTrigger(),
			timedWait(),
			setNode('child-finished'),
		]);
		child.settings = { executionOrder: 'v1', callerPolicy: 'any' };
		published(instance, child);
		await activate(
			instance,
			workflow('durable-parent', [
				webhookNode('durable-parent', 'GET', 'onReceived'),
				call('durable-child'),
				setNode('={{ "parent got " + $json.result }}'),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/durable-parent`);
		await eventually(() => {
			expect(statusOf('durable-parent')).toBe('waiting');
			expect(statusOf('durable-child')).toBe('waiting');
		});
		const childId = String(executions(instance, 'durable-child')[0].id);
		await post('/__test/runner/durable-child/advance-wait', {
			executionId: childId,
			due: Date.now() + 300,
		});
		// The fallback check of the parent runs after 60 seconds. Only the child's notification is this fast.
		await eventually(() => expect(statusOf('durable-parent')).toBe('success'), 15_000);
		expect(statusOf('durable-child')).toBe('success');
		const parentId = executions(instance, 'durable-parent')[0].id;
		expect(JSON.stringify(await savedData(parentId))).toContain('parent got child-finished');
	});

	it('keeps the accepted run of a webhook resume when a stale alarm entry runs', async () => {
		await activate(
			instance,
			workflow('limited-wait', [
				webhookNode('limited-wait', 'GET', 'onReceived'),
				webhookWait({
					limitWaitTime: true,
					limitType: 'afterTimeInterval',
					resumeAmount: 2,
					resumeUnit: 'minutes',
				}),
				slow(instance.origin),
				setNode('resumed'),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/limited-wait`);
		await eventually(() => expect(statusOf('limited-wait')).toBe('waiting'));
		const id = String(executions(instance, 'limited-wait')[0].id);
		const key = `pending:${id}`;
		const timed = (await probe('limited-wait')).pending[key];
		expect(timed).toMatchObject({ kind: 'resume' });
		const { resumeToken } = await savedData(id);
		const resumed = await instance.worker.fetch(
			`${instance.origin}/webhook-waiting/${id}?signature=${resumeToken}`,
			{ method: 'POST' },
		);
		expect(resumed.status).toBe(200);
		await eventually(async () =>
			expect((await probe('limited-wait')).pending[key]).toEqual({ kind: 'run' }),
		);

		// The time limit alarm read its entry before the webhook resumed the wait.
		await post('/__test/runner/limited-wait/stale-entry', { executionId: id, entry: timed });
		expect((await probe('limited-wait')).pending[key]).toEqual({ kind: 'run' });
		await eventually(() => expect(statusOf('limited-wait')).toBe('success'));
	});

	describe('between accept and run', () => {
		const gapWorkflow = async (id: string) => {
			await activate(
				instance,
				workflow(id, [webhookNode(id), slow(instance.origin), setNode('finished')]),
			);
			await post(`/__test/runner/${id}/control`, { webhookConfigDelayMs: 2000 });
			const response = instance.worker.fetch(`${instance.origin}/webhook/${id}`);
			// The run is accepted: its pending entry exists, and the runner still reads its webhook settings.
			await eventually(async () =>
				expect(Object.values((await probe(id)).pending)).toEqual([{ kind: 'run' }]),
			);
			return { response, executionId: String(executions(instance, id)[0].id) };
		};

		it('applies a stop', async () => {
			const { response, executionId } = await gapWorkflow('gap-stop');
			expect((await post(`/__test/stop/${executionId}`)).status).toBe(200);
			expect((await response).status).toBe(500);
			expect(statusOf('gap-stop')).toBe('canceled');
			const { runData } = (await savedData(executionId)).resultData;
			expect(runData).not.toHaveProperty('Slow');
			expect(runData).not.toHaveProperty('Set');
		});

		it('keeps the run when the watchdog alarm fires', async () => {
			const { response } = await gapWorkflow('gap-alarm');
			const before = (await probe('gap-alarm')).alarms;
			await post('/__test/runner/gap-alarm/fire-alarm');
			await eventually(async () => expect((await probe('gap-alarm')).alarms).toBe(before + 1));
			expect(statusOf('gap-alarm')).not.toBe('crashed');
			expect(Object.values((await probe('gap-alarm')).pending)).toEqual([{ kind: 'run' }]);
			const answered = await response;
			expect(await answered.json()).toEqual({ result: 'finished' });
			expect(statusOf('gap-alarm')).toBe('success');
		});

		it('refuses a version reset, and resets once idle', async () => {
			const { response } = await gapWorkflow('gap-version');
			const future = new Date(Date.now() + 86_400_000).toISOString();
			const during = await post('/__test/runner/gap-version/version-check', { timestamp: future });
			expect(await during.json()).toEqual({ reset: false });
			expect(await (await response).json()).toEqual({ result: 'finished' });
			await eventually(async () => expect((await probe('gap-version')).pending).toEqual({}));
			const idle = await post('/__test/runner/gap-version/version-check', { timestamp: future });
			expect(await idle.json()).toEqual({ reset: true });
		});

		it('does not start the engine when the execution was stopped elsewhere', async () => {
			const { response, executionId } = await gapWorkflow('gap-row');
			execDb(
				instance,
				`UPDATE execution_entity SET status = 'canceled' WHERE id = ${Number(executionId)}`,
			);
			expect((await response).status).toBe(500);
			expect(statusOf('gap-row')).toBe('canceled');
			const data = await savedData(executionId);
			expect(data.resultData.runData).not.toHaveProperty('Slow');
			expect(data.resultData.error?.message).toBeTruthy();
		});
	});

	it('records the stop of a waiting child and resumes its parent with the error', async () => {
		const child = workflow('stop-wait-child', [
			childTrigger(),
			webhookWait(),
			setNode('child-done'),
		]);
		child.settings = { executionOrder: 'v1', callerPolicy: 'any' };
		published(instance, child);
		await activate(
			instance,
			workflow('stop-wait-parent', [
				webhookNode('stop-wait-parent', 'GET', 'onReceived'),
				call('stop-wait-child'),
				setNode('parent-continued'),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/stop-wait-parent`);
		await eventually(() => {
			expect(statusOf('stop-wait-parent')).toBe('waiting');
			expect(statusOf('stop-wait-child')).toBe('waiting');
		});
		const childId = String(executions(instance, 'stop-wait-child')[0].id);
		expect((await post(`/__test/stop/${childId}`)).status).toBe(200);
		expect(statusOf('stop-wait-child')).toBe('canceled');
		expect((await savedData(childId)).resultData.error?.message).toMatch(/cancel/i);
		// The fallback check of the parent runs after 60 seconds. Only the stop's notification is this fast.
		await eventually(
			() => expect(['canceled', 'error']).toContain(statusOf('stop-wait-parent')),
			15_000,
		);
		const parent = await savedData(executions(instance, 'stop-wait-parent')[0].id);
		expect(parent.resultData.runData).not.toHaveProperty('Set');
	});

	it('backs off the fallback check while no child has a result, and resumes a parent of a crashed child', async () => {
		const child = workflow('crash-child', [childTrigger(), webhookWait(), setNode('child-done')]);
		child.settings = { executionOrder: 'v1', callerPolicy: 'any' };
		published(instance, child);
		await activate(
			instance,
			workflow('crash-parent', [
				webhookNode('crash-parent', 'GET', 'onReceived'),
				call('crash-child'),
				setNode('parent-continued'),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/crash-parent`);
		await eventually(() => expect(statusOf('crash-parent')).toBe('waiting'));
		const parentId = String(executions(instance, 'crash-parent')[0].id);
		const key = `pending:${parentId}`;
		await eventually(async () =>
			expect((await probe('crash-parent')).pending[key]).toMatchObject({
				kind: 'child',
				attempt: 1,
			}),
		);
		const first = (await probe('crash-parent')).pending[key];
		await post('/__test/runner/crash-parent/stale-entry', { executionId: parentId, entry: first });
		const second = (await probe('crash-parent')).pending[key];
		expect(second).toMatchObject({ kind: 'child', attempt: 2 });
		expect(second.due! - Date.now()).toBeGreaterThan(100_000);

		// The child crashed. The parent resumes with an error instead of waiting forever.
		const childId = String(executions(instance, 'crash-child')[0].id);
		execDb(
			instance,
			`UPDATE execution_entity SET status = 'crashed' WHERE id = ${Number(childId)}`,
		);
		await post('/__test/runner/crash-parent/stale-entry', { executionId: parentId, entry: second });
		await eventually(() => expect(statusOf('crash-parent')).toBe('error'));
		expect((await savedData(parentId)).resultData.error?.message).toContain('crashed');
	});

	it('saves a failed run with hooks when a run fails before the engine starts', async () => {
		const handler = workflow('refused-handler', [node('Error', 'errorTrigger', {}), setNode()]);
		handler.settings = { executionOrder: 'v1', callerPolicy: 'any' };
		published(instance, handler);
		const refused = workflow('refused-credential', [
			webhookNode('refused-credential'),
			{
				...node(
					'Http',
					'httpRequest',
					{
						url: `${instance.origin}/__test/slow`,
						authentication: 'genericCredentialType',
						genericAuthType: 'httpBasicAuth',
						options: {},
					},
					4.2,
				),
				credentials: { httpBasicAuth: { id: 'not-shared', name: 'Not shared' } },
			},
		]);
		refused.settings = { executionOrder: 'v1', errorWorkflow: 'refused-handler' };
		await activate(instance, refused);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/refused-credential`);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ message: 'Error in workflow' });
		const row = executions(instance, 'refused-credential')[0];
		expect(row.status).toBe('error');
		const data = await savedData(row.id);
		expect(data.resultData.error?.message).toContain('does not have access to the credential');
		await eventually(() => expect(statusOf('refused-handler')).toBe('success'));
	});

	it('gives the parent the real error of a child that fails before the engine starts', async () => {
		const child = workflow('unknown-type-child', [
			childTrigger(),
			{ ...setNode(), type: 'n8n-nodes-base.doesNotExist' },
		]);
		child.settings = { executionOrder: 'v1', callerPolicy: 'any' };
		published(instance, child);
		await activate(
			instance,
			workflow('unknown-type-parent', [
				webhookNode('unknown-type-parent'),
				call('unknown-type-child'),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/unknown-type-parent`);
		expect(response.status).toBe(500);
		expect(statusOf('unknown-type-child')).toBe('error');
		const childData = await savedData(executions(instance, 'unknown-type-child')[0].id);
		const message = childData.resultData.error?.message;
		expect(message).toContain('doesNotExist');
		const parent = await savedData(executions(instance, 'unknown-type-parent')[0].id);
		expect(parent.resultData.error?.message).toBe(message);
	});

	it('finishes a run whose request snapshot could not be written', async () => {
		const data = workflow('snapshot-fail', [node('Manual', 'manualTrigger', {}), setNode()]);
		seed(instance, data);
		await post('/__test/runner/snapshot-fail/control', { failRequestPuts: 1 });
		const started = await post('/__test/run', {
			workflowData: data,
			executionMode: 'manual',
			destinationNode: { nodeName: 'Set', mode: 'inclusive' },
		});
		expect(started.status).toBe(200);
		// Read through the worker. The run writes D1 at this moment, and a direct file read can find it locked.
		await eventually(async () => {
			const rows = (await (
				await instance.worker.fetch(`${instance.origin}/__test/executions/snapshot-fail`)
			).json()) as Array<{ status: string }>;
			expect(rows.map((row) => row.status)).toEqual(['success']);
		});
	});

	it('moves webhook uploads from the temp execution ID and streams the binary response', async () => {
		await activate(
			instance,
			workflow('upload', [
				webhookNode('upload', 'POST', 'lastNode', {
					responseData: 'firstEntryBinary',
					responseBinaryPropertyName: 'data',
				}),
			]),
		);
		const body = Buffer.alloc(3 * 1024 * 1024, 7);
		body.write('start');
		const response = await instance.worker.fetch(`${instance.origin}/webhook/upload`, {
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream' },
			body,
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-security-policy')).toMatch(/^sandbox /);
		expect(response.headers.get('content-type')).toBe('application/octet-stream');
		// A buffered body has a known length. A streamed body does not.
		expect(response.headers.get('content-length')).toBeNull();
		expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);

		const id = String(executions(instance, 'upload')[0].id);
		await eventually(() => expect(statusOf('upload')).toBe('success'));
		const binaryId = (await savedData(id)).resultData.runData.Webhook[0].data?.main[0][0].binary
			?.data?.id;
		expect(binaryId).toContain(`/executions/${id}/`);
		expect(await r2Keys(`binary/${id}/upload/`)).toHaveLength(1);
		expect(await r2Keys('binary/temp/upload/')).toEqual([]);
	});

	// Pruning works on every execution of the instance, so these tests run last.
	it('deletes temp binary leftovers only when no older execution is in progress', async () => {
		await post('/__test/r2', { key: 'binary/temp/leftover/file' });
		const later = Date.now() + 2 * 3_600_000;
		execDb(
			instance,
			`INSERT INTO execution_entity (id, workflowId, mode, status, finished, createdAt) VALUES (900001, 'resume-spin', 'webhook', 'running', 0, ${literal(new Date().toISOString())})`,
		);
		await post('/__test/prune', { now: later });
		expect(await r2Keys('binary/temp/leftover/')).toEqual(['binary/temp/leftover/file']);
		execDb(instance, "UPDATE execution_entity SET status = 'crashed' WHERE id = 900001");
		await post('/__test/prune', { now: later });
		expect(await r2Keys('binary/temp/leftover/')).toEqual([]);
	});

	it('hard-deletes more than one batch of executions in a run', async () => {
		const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
		const values = Array.from(
			{ length: 250 },
			(_, index) =>
				`(${910_000 + index}, 'resume-spin', 'webhook', 'success', 1, ${literal(old)}, ${literal(old)}, ${literal(old)})`,
		).join(', ');
		execDb(
			instance,
			`INSERT INTO execution_entity (id, workflowId, mode, status, finished, createdAt, stoppedAt, deletedAt) VALUES ${values}`,
		);
		await post('/__test/prune', { now: Date.now() });
		expect(executions(instance, 'resume-spin').filter((row) => Number(row.id) >= 910_000)).toEqual(
			[],
		);
	});
});
