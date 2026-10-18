import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstance } from '../api/harness';
import type { Instance } from '../api/harness';
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

describe('built worker webhooks', () => {
	let instance: Instance;
	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it.each(['GET', 'POST'])(
		'runs a production %s webhook with a lastNode response',
		async (method) => {
			const path = `last-${method}`;
			await activate(instance, workflow(path, [webhookNode(path, method), setNode()]));
			const response = await instance.worker.fetch(`${instance.origin}/webhook/${path}`, {
				method,
				headers: { 'content-type': 'application/json' },
				body: method === 'POST' ? JSON.stringify({ input: true }) : undefined,
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ result: 'worked' });
			expect(executions(instance, path)[0]).toMatchObject({ status: 'success', mode: 'webhook' });
		},
	);

	it('captures a Respond to Webhook status, headers and body', async () => {
		await activate(
			instance,
			workflow('response-node', [
				webhookNode('response-node', 'POST', 'responseNode'),
				node(
					'Respond',
					'respondToWebhook',
					{
						respondWith: 'json',
						responseBody: '{"custom":true}',
						options: {
							responseCode: 202,
							responseHeaders: { entries: [{ name: 'X-Custom', value: 'yes' }] },
						},
					},
					1.4,
				),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/response-node`, {
			method: 'POST',
		});
		expect(response.status).toBe(202);
		expect(response.headers.get('x-custom')).toBe('yes');
		expect(await response.json()).toEqual({ custom: true });
	});

	it('returns onReceived and completes in the runner', async () => {
		await activate(
			instance,
			workflow('immediate', [webhookNode('immediate', 'GET', 'onReceived'), setNode()]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/immediate`);
		expect(await response.json()).toEqual({ message: 'Workflow was started' });
		await eventually(() =>
			expect(executions(instance, 'immediate')[0]).toMatchObject({
				status: 'success',
				finished: 1,
				instanceId: expect.any(String),
			}),
		);
	});

	it('routes a dynamic path and exposes params to the engine', async () => {
		await activate(
			instance,
			workflow('dynamic', [webhookNode('users/:userId'), setNode('={{ $json.params.userId }}')]),
		);
		const response = await instance.worker.fetch(
			`${instance.origin}/webhook/Webhook-webhook/users/42`,
		);
		expect(await response.json()).toEqual({ result: '42' });
	});

	it('returns the stock unknown path message', async () => {
		const response = await instance.worker.fetch(`${instance.origin}/webhook/missing`);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			message: 'The requested webhook "GET missing" is not registered.',
		});
	});

	it('handles CORS preflight without creating an execution', async () => {
		await activate(instance, workflow('cors', [webhookNode('cors'), setNode()]));
		const response = await instance.worker.fetch(`${instance.origin}/webhook/cors`, {
			method: 'OPTIONS',
			headers: {
				origin: 'https://client.example',
				'access-control-request-method': 'GET',
				'access-control-request-headers': 'x-custom',
			},
		});
		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBe('https://client.example');
		expect(response.headers.get('access-control-allow-headers')).toBe('x-custom');
		expect(executions(instance, 'cors')).toHaveLength(0);
	});

	it('registers, executes and consumes a manual test webhook', async () => {
		const data = workflow('manual-webhook', [webhookNode('manual-webhook'), setNode()]);
		seed(instance, data);
		const registration = await instance.worker.fetch(`${instance.origin}/__test/register`, {
			method: 'POST',
			body: JSON.stringify(data),
		});
		expect(await registration.json()).toEqual({ registered: true });
		const response = await instance.worker.fetch(`${instance.origin}/webhook-test/manual-webhook`);
		expect(await response.json()).toEqual({ result: 'worked' });
		expect(executions(instance, data.id!)[0]).toMatchObject({ mode: 'manual', status: 'success' });
		expect(
			(await instance.worker.fetch(`${instance.origin}/webhook-test/manual-webhook`)).status,
		).toBe(404);
	});

	it('does not match expired registrations and supports cancel', async () => {
		const data = workflow('expired', [webhookNode('expired'), setNode()]);
		seed(instance, data);
		await instance.worker.fetch(`${instance.origin}/__test/register`, {
			method: 'POST',
			body: JSON.stringify(data),
		});
		execDb(
			instance,
			`UPDATE test_webhook SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE workflowId = ${literal(data.id!)};`,
		);
		expect((await instance.worker.fetch(`${instance.origin}/webhook-test/expired`)).status).toBe(
			404,
		);
		await instance.worker.fetch(`${instance.origin}/__test/register/${data.id}`, {
			method: 'DELETE',
		});
		expect(queryDb(instance, 'SELECT * FROM test_webhook')).toEqual([]);
	});

	it('resumes a Wait webhook with token validation and prevents a second resume', async () => {
		await activate(
			instance,
			workflow('waiting', [
				webhookNode('waiting'),
				node(
					'Wait',
					'wait',
					{
						resume: 'webhook',
						httpMethod: 'POST',
						responseMode: 'lastNode',
						responseData: 'firstEntryJson',
						options: {},
						authentication: 'none',
						limitWaitTime: false,
					},
					1.1,
				),
				setNode('={{ $json.body.answer }}'),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/waiting`);
		const execution = executions(instance, 'waiting')[0];
		expect(execution.status).toBe('waiting');
		const saved = (await (
			await instance.worker.fetch(`${instance.origin}/__test/data/${execution.id}`)
		).json()) as { resumeToken: string };
		expect(saved.resumeToken).toEqual(expect.any(String));
		const endpoint = `${instance.origin}/webhook-waiting/${execution.id}`;
		expect((await instance.worker.fetch(endpoint, { method: 'POST' })).status).toBe(401);
		const response = await instance.worker.fetch(`${endpoint}?signature=${saved.resumeToken}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"answer":"resumed"}',
		});
		expect(await response.json()).toEqual({ result: 'resumed' });
		expect(executions(instance, 'waiting')[0]).toMatchObject({ status: 'success', finished: 1 });
		expect(
			(
				await instance.worker.fetch(`${endpoint}?signature=${saved.resumeToken}`, {
					method: 'POST',
				})
			).status,
		).toBe(409);
	});

	it('serves the stock form template and accepts multipart submissions', async () => {
		await activate(
			instance,
			workflow('form', [
				node(
					'Form',
					'formTrigger',
					{
						path: 'form',
						formTitle: 'Contact us',
						formDescription: 'Send a message',
						formFields: {
							values: [{ fieldLabel: 'Name', fieldType: 'text', requiredField: true }],
						},
						responseMode: 'onReceived',
						authentication: 'none',
						options: {},
					},
					2,
				),
				setNode(),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/form/form`);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(await response.text()).toContain('Contact us');
		expect(executions(instance, 'form')).toHaveLength(0);
		const form = new FormData();
		form.set('field-0', 'Ada');
		const encoded = new Request(`${instance.origin}/form/form`, { method: 'POST', body: form });
		const submitted = await instance.worker.fetch(`${instance.origin}/form/form`, {
			method: 'POST',
			body: Buffer.from(await encoded.arrayBuffer()),
			headers: { 'content-type': encoded.headers.get('content-type')! },
		});
		expect(submitted.status).toBe(200);
		await eventually(() =>
			expect(executions(instance, 'form')[0]).toMatchObject({ status: 'success' }),
		);
	});

	it.each([
		['application/x-www-form-urlencoded', 'answer=urlencoded', 'urlencoded'],
		['text/plain', 'plain text', 'plain text'],
		['application/json', '{"answer":"json"}', 'json'],
	])('adapts a %s body and repeated query parameters', async (contentType, body, expected) => {
		const path = `body-${expected.replace(/ /g, '-')}`;
		const set = setNode(
			contentType === 'text/plain' ? '={{ $json.body }}' : '={{ $json.body.answer }}',
		);
		await activate(instance, workflow(path, [webhookNode(path, 'POST'), set]));
		const response = await instance.worker.fetch(
			`${instance.origin}/webhook/${path}?tag=one&tag=two`,
			{ method: 'POST', headers: { 'content-type': contentType }, body },
		);
		expect(await response.json()).toEqual({ result: expected });
	});

	it('rejects malformed JSON before starting an execution', async () => {
		await activate(
			instance,
			workflow('invalid-json', [webhookNode('invalid-json', 'POST'), setNode()]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/invalid-json`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{',
		});
		expect(response.status).toBe(400);
		expect(executions(instance, 'invalid-json')).toHaveLength(0);
	});

	it('returns raw binary with lastNode and a custom status and header', async () => {
		await activate(
			instance,
			workflow('binary', [
				webhookNode('binary', 'POST', 'lastNode', {
					responseData: 'firstEntryBinary',
					responseBinaryPropertyName: 'data',
					options: {
						rawBody: true,
						responseCode: { values: { responseCode: 201 } },
						responseHeaders: { entries: [{ name: 'X-Binary', value: 'yes' }] },
					},
				}),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/binary`, {
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream' },
			body: Buffer.from([0, 1, 255]),
		});
		expect(response.status).toBe(201);
		expect(response.headers.get('x-binary')).toBe('yes');
		expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0, 1, 255]));
	});

	it('returns a multipart file through Respond to Webhook', async () => {
		await activate(
			instance,
			workflow('binary-response', [
				webhookNode('binary-response', 'POST', 'responseNode'),
				node(
					'Respond',
					'respondToWebhook',
					{
						respondWith: 'binary',
						responseDataSource: 'set',
						inputFieldName: 'file',
						options: {},
					},
					1.4,
				),
			]),
		);
		const form = new FormData();
		form.set('note', 'metadata');
		form.set('file', new Blob(['file contents'], { type: 'text/plain' }), 'upload.txt');
		const encoded = new Request(`${instance.origin}/webhook/binary-response`, {
			method: 'POST',
			body: form,
		});
		const response = await instance.worker.fetch(encoded.url, {
			method: 'POST',
			body: Buffer.from(await encoded.arrayBuffer()),
			headers: { 'content-type': encoded.headers.get('content-type')! },
		});
		expect(response.status, await response.clone().text()).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/plain');
		expect(await response.text()).toBe('file contents');
	});

	it('uses the published version when the draft has changed', async () => {
		const data = workflow('published', [webhookNode('published'), setNode('published data')]);
		seed(instance, data);
		execDb(
			instance,
			`INSERT INTO workflow_history (versionId, workflowId, nodes, connections, authors, createdAt, updatedAt)
			VALUES ('published-v1', 'published', ${literal(JSON.stringify(data.nodes))}, ${literal(JSON.stringify(data.connections))}, 'test', datetime('now'), datetime('now'));
			UPDATE workflow_entity SET activeVersionId = 'published-v1', nodes = ${literal(JSON.stringify([webhookNode('draft'), setNode('draft data')]))} WHERE id = 'published';`,
		);
		const activated = await instance.worker.fetch(`${instance.origin}/__test/activate/published`, {
			method: 'POST',
		});
		expect(await activated.json()).toEqual({ active: true });
		const response = await instance.worker.fetch(`${instance.origin}/webhook/published`);
		expect(await response.json()).toEqual({ result: 'published data' });
		expect(executions(instance, 'published')[0].workflowVersionId).toBe('published-v1');
		expect((await instance.worker.fetch(`${instance.origin}/webhook/draft`)).status).toBe(404);
	});

	it('serves and resumes a Wait form without consuming it on GET', async () => {
		await activate(
			instance,
			workflow('wait-form', [
				webhookNode('wait-form'),
				node(
					'WaitForm',
					'wait',
					{
						resume: 'form',
						formTitle: 'Follow-up',
						formDescription: '',
						formFields: { values: [{ fieldLabel: 'Answer', fieldType: 'text' }] },
						responseMode: 'onReceived',
						options: {},
						limitWaitTime: false,
					},
					1.1,
				),
				setNode('={{ $json.Answer }}'),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/wait-form`);
		const execution = executions(instance, 'wait-form')[0];
		expect(execution.status).toBe('waiting');
		const saved = (await (
			await instance.worker.fetch(`${instance.origin}/__test/data/${execution.id}`)
		).json()) as { resumeToken: string };
		const endpoint = `${instance.origin}/form-waiting/${execution.id}?signature=${saved.resumeToken}`;
		const page = await instance.worker.fetch(endpoint);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('Follow-up');
		expect(executions(instance, 'wait-form')[0].status).toBe('waiting');
		const form = new FormData();
		form.set('field-0', 'from form');
		const encoded = new Request(endpoint, { method: 'POST', body: form });
		const submitted = await instance.worker.fetch(endpoint, {
			method: 'POST',
			body: Buffer.from(await encoded.arrayBuffer()),
			headers: { 'content-type': encoded.headers.get('content-type')! },
		});
		expect(submitted.status).toBe(200);
		expect(executions(instance, 'wait-form')[0]).toMatchObject({ status: 'success' });
	});

	it('claims a waiting execution once under concurrent resume requests', async () => {
		await activate(
			instance,
			workflow('concurrent', [
				webhookNode('concurrent'),
				node(
					'WaitConcurrent',
					'wait',
					{
						resume: 'webhook',
						httpMethod: 'POST',
						responseMode: 'lastNode',
						responseData: 'firstEntryJson',
						authentication: 'none',
						limitWaitTime: false,
						options: {},
					},
					1.1,
				),
				setNode(),
			]),
		);
		await instance.worker.fetch(`${instance.origin}/webhook/concurrent`);
		const execution = executions(instance, 'concurrent')[0];
		const saved = (await (
			await instance.worker.fetch(`${instance.origin}/__test/data/${execution.id}`)
		).json()) as { resumeToken: string };
		const endpoint = `${instance.origin}/webhook-waiting/${execution.id}?signature=${saved.resumeToken}`;
		const responses = await Promise.all([
			instance.worker.fetch(endpoint, { method: 'POST' }),
			instance.worker.fetch(endpoint, { method: 'POST' }),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
		expect(executions(instance, 'concurrent')).toHaveLength(1);
	});

	it('runs a Form Trigger followed by a Form page', async () => {
		await activate(
			instance,
			workflow('multi-form', [
				node(
					'FirstForm',
					'formTrigger',
					{
						path: 'multi-form',
						formTitle: 'First page',
						formDescription: '',
						formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] },
						responseMode: 'onReceived',
						authentication: 'none',
						options: {},
					},
					2,
				),
				node(
					'SecondForm',
					'form',
					{
						operation: 'page',
						defineForm: 'fields',
						formTitle: 'Second page',
						formDescription: '',
						formFields: { values: [{ fieldLabel: 'Second', fieldType: 'text' }] },
						options: { formTitle: 'Second page' },
						limitWaitTime: false,
					},
					1,
				),
				setNode(),
			]),
		);
		const first = new FormData();
		first.set('field-0', 'Ada');
		const encodedFirst = new Request(`${instance.origin}/form/multi-form`, {
			method: 'POST',
			body: first,
		});
		const submittedFirst = await instance.worker.fetch(encodedFirst.url, {
			method: 'POST',
			body: Buffer.from(await encodedFirst.arrayBuffer()),
			headers: { 'content-type': encodedFirst.headers.get('content-type')! },
		});
		expect(submittedFirst.status, await submittedFirst.clone().text()).toBe(200);
		const body = (await submittedFirst.json()) as { formWaitingUrl: string };
		expect(body.formWaitingUrl).toContain('/form-waiting/');
		const page = await instance.worker.fetch(body.formWaitingUrl);
		expect(page.status, await page.clone().text()).toBe(200);
		expect((await page.text()).includes('Second page')).toBe(true);
		const second = new FormData();
		second.set('field-0', 'submitted second');
		const encodedSecond = new Request(body.formWaitingUrl, { method: 'POST', body: second });
		const submittedSecond = await instance.worker.fetch(body.formWaitingUrl, {
			method: 'POST',
			body: Buffer.from(await encodedSecond.arrayBuffer()),
			headers: { 'content-type': encodedSecond.headers.get('content-type')! },
		});
		expect(submittedSecond.status, await submittedSecond.clone().text()).toBe(200);
		expect(executions(instance, 'multi-form')[0]).toMatchObject({ status: 'success' });
	});

	it('pushes testWebhookReceived and testWebhookDeleted to the editor', async () => {
		const socket = new WebSocket(
			`${instance.origin.replace('http:', 'ws:')}/__test/push?pushRef=test-ref&userId=test-user`,
		);
		const messages: unknown[] = [];
		socket.addEventListener('message', (event) => {
			if (typeof event.data === 'string') messages.push(JSON.parse(event.data));
		});
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener('open', () => resolve(), { once: true });
			socket.addEventListener('error', reject, { once: true });
		});
		try {
			const data = workflow('push-test', [webhookNode('push-test'), setNode()]);
			seed(instance, data);
			await instance.worker.fetch(`${instance.origin}/__test/register`, {
				method: 'POST',
				body: JSON.stringify(data),
			});
			await instance.worker.fetch(`${instance.origin}/webhook-test/push-test`);
			await eventually(() =>
				expect(messages).toContainEqual({
					type: 'testWebhookReceived',
					data: { workflowId: data.id, executionId: String(executions(instance, data.id!)[0].id) },
				}),
			);
			await instance.worker.fetch(`${instance.origin}/__test/register`, {
				method: 'POST',
				body: JSON.stringify(data),
			});
			await instance.worker.fetch(`${instance.origin}/__test/register/${data.id}`, {
				method: 'DELETE',
			});
			await eventually(() =>
				expect(messages).toContainEqual({
					type: 'testWebhookDeleted',
					data: { workflowId: data.id },
				}),
			);
		} finally {
			socket.close();
		}
	});

	it('cleans test registrations from a real expiry alarm', async () => {
		const data = workflow('expiry-alarm', [webhookNode('expiry-alarm'), setNode()]);
		seed(instance, data);
		await instance.worker.fetch(`${instance.origin}/__test/register`, {
			method: 'POST',
			body: JSON.stringify(data),
		});
		execDb(
			instance,
			"UPDATE test_webhook SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE workflowId = 'expiry-alarm'",
		);
		await instance.worker.fetch(`${instance.origin}/__test/expire/${data.id}`, { method: 'POST' });
		await eventually(() =>
			expect(
				queryDb(instance, "SELECT * FROM test_webhook WHERE workflowId = 'expiry-alarm'"),
			).toEqual([]),
		);
	});

	it('answers onReceived while the durable execution is still waiting', async () => {
		await activate(
			instance,
			workflow('immediate-wait', [
				webhookNode('immediate-wait', 'GET', 'onReceived'),
				node('TimedWait', 'wait', { resume: 'timeInterval', amount: 2, unit: 'seconds' }, 1.1),
				setNode(),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/immediate-wait`);
		expect(await response.json()).toEqual({ message: 'Workflow was started' });
		expect(executions(instance, 'immediate-wait')[0].status).not.toBe('success');
		await eventually(() =>
			expect(executions(instance, 'immediate-wait')[0].status).toBe('success'),
		);
	});

	it('detects an unparsed binary request body', async () => {
		await activate(
			instance,
			workflow('automatic-binary', [
				webhookNode('automatic-binary', 'POST', 'lastNode', {
					responseData: 'firstEntryBinary',
					responseBinaryPropertyName: 'data',
				}),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/automatic-binary`, {
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream' },
			body: Buffer.from([2, 0, 255]),
		});
		expect(response.status, await response.clone().text()).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([2, 0, 255]));
	});

	it('applies responsePropertyName and responseContentType to firstEntryJson', async () => {
		await activate(
			instance,
			workflow('response-options', [
				webhookNode('response-options', 'POST', 'lastNode', {
					responseData: 'firstEntryJson',
					options: {
						responsePropertyName: 'body',
						responseContentType: 'application/vnd.example+json',
					},
				}),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/response-options`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"selected":"value"}',
		});
		expect(response.headers.get('content-type')).toBe('application/vnd.example+json');
		expect(await response.json()).toEqual({ selected: 'value' });
	});

	it('returns allEntries as an array', async () => {
		await activate(
			instance,
			workflow('all-entries', [
				webhookNode('all-entries', 'GET', 'lastNode', { responseData: 'allEntries' }),
				setNode(),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/all-entries`);
		expect(await response.json()).toEqual([{ result: 'worked' }]);
	});

	it('resumes a webhook Wait from the runner alarm when its time limit ends', async () => {
		await activate(
			instance,
			workflow('inline-timed-wait', [
				webhookNode('inline-timed-wait'),
				node(
					'InlineWait',
					'wait',
					{
						resume: 'webhook',
						httpMethod: 'POST',
						responseMode: 'onReceived',
						options: {},
						limitWaitTime: true,
						limitType: 'afterTimeInterval',
						resumeAmount: 2,
						resumeUnit: 'seconds',
					},
					1.1,
				),
				setNode(),
			]),
		);
		const response = await instance.worker.fetch(`${instance.origin}/webhook/inline-timed-wait`);
		expect(response.status).toBe(200);
		expect(executions(instance, 'inline-timed-wait')[0].status).toBe('waiting');
		await eventually(() =>
			expect(executions(instance, 'inline-timed-wait')[0]).toMatchObject({
				status: 'success',
				instanceId: 'runner:inline-timed-wait',
			}),
		);
	});
});
