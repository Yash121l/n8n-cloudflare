import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Instance, Session } from '../api/harness';
import { startInstance } from '../api/harness';
import {
	chain,
	codeNode,
	createWorkflow,
	manualTrigger,
	outputOf,
	runManually,
} from './code-harness';

describe('Code node after an HTTP Request node', () => {
	let instance: Instance;
	let session: Session;
	const server = createServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ slideshow: { title: 'Sample Slide Show' } }));
	});
	let url = '';

	beforeAll(async () => {
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/json`;
		instance = await startInstance();
		session = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
		server.close();
	});

	// The HTTP client keeps circular request objects in run data. The sandbox task must still serialize.
	it('reads the HTTP response in the Code sandbox', async () => {
		const http = {
			id: 'http',
			name: 'HTTP Request',
			type: 'n8n-nodes-base.httpRequest',
			typeVersion: 4.2,
			position: [200, 0],
			parameters: { url, options: {} },
		};
		const code = codeNode(
			'Code',
			'return [{ json: { title: $input.first().json.slideshow.title } }];',
		);
		const workflow = await createWorkflow(
			session,
			'HTTP then Code',
			[manualTrigger, http, code],
			chain('Manual', 'HTTP Request', 'Code'),
		);
		const { status, data } = await runManually(session, workflow);
		expect(data.resultData.error?.message).toBeUndefined();
		expect(status).toBe('success');
		expect(outputOf(data, 'Code')).toEqual([{ title: 'Sample Slide Show' }]);
	});
});
