import { afterAll, beforeAll, describe, it } from 'vitest';
import type { Browser } from 'playwright';

import { OWNER, dataOf, recordOf, startInstance } from '../api/harness';
import type { Instance } from '../api/harness';
import { addNode, expect, launch, loginViaForm, newPage, signedInPage } from './browser';

describe('editor in a browser', () => {
	let instance: Instance;
	let browser: Browser;

	/** A workflow made through the API, so tests that are not about building one start from a known graph. */
	async function createWorkflow(name: string, nodes: unknown[], connections: unknown) {
		const session = await instance.ownerSession();
		const res = await session.post('/rest/workflows', {
			name,
			nodes,
			connections,
			settings: { executionOrder: 'v1' },
		});
		if (res.status !== 200) throw new Error(JSON.stringify(res.body));
		return String(recordOf(dataOf(res)).id);
	}

	beforeAll(async () => {
		instance = await startInstance();
		await instance.ownerSession();
		browser = await launch();
	});
	afterAll(async () => {
		await browser?.close();
		await instance?.dispose();
	});

	it('logs the owner in through the sign-in form', async () => {
		const { page, context } = await newPage(browser, instance, 'login');
		await page.goto('/home/workflows');
		await page.waitForURL(/\/signin/);
		await loginViaForm(page);
		await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/(home|workflows|workflow)/);
		const cookies = await context.cookies();
		expect(cookies.some((c) => c.name === 'n8n-auth' && c.httpOnly)).toBe(true);
		await context.close();
	});

	it('loads the editor without an Offline badge', async () => {
		const { page, context } = await signedInPage(browser, instance, 'offline');
		const socket = page.waitForEvent('websocket', (ws) => ws.url().includes('/rest/push'));
		await page.goto('/workflow/new');
		await page.getByTestId('canvas-plus-button').waitFor();
		// The editor shows Offline when the push connection is down, so wait for it to open and stay open.
		const ws = await socket;
		await page.waitForTimeout(2000);
		expect(ws.isClosed()).toBe(false);
		await expect(page.getByText('Offline', { exact: true })).toHaveCount(0);
		await context.close();
	});

	it('builds, saves and runs a workflow from the canvas and shows the output in the NDV', async () => {
		const { page, context } = await signedInPage(browser, instance, 'build-run');
		await page.goto('/workflow/new');
		await addNode(page, 'Manual', 'Trigger manually', { first: true });
		await addNode(page, 'Edit Fields', 'Edit Fields (Set)');

		const ndv = page.getByTestId('ndv');
		await ndv.getByText('Add Field', { exact: true }).click();
		await ndv.getByTestId('assignment-name').locator('input').fill('greeting');
		await ndv
			.getByTestId('assignment-value')
			.locator('input, textarea')
			.first()
			.fill('hello from the browser');
		await page.getByTestId('ndv-close-button').click();

		await addNode(page, 'Code', 'Code', { action: 'Code in JavaScript' });
		await page.getByTestId('ndv-close-button').click();
		await expect(page.getByTestId('canvas-node')).toHaveCount(3);

		const save = page.waitForResponse(
			(res) =>
				/\/rest\/workflows(\/|$)/.test(res.url()) &&
				['POST', 'PATCH'].includes(res.request().method()),
		);
		await page.keyboard.press('ControlOrMeta+s');
		expect((await save).status()).toBe(200);
		await page.waitForURL(/\/workflow\/[^/?]+/);

		await page.getByTestId('execute-workflow-button').click();
		await expect(page.getByTestId('canvas-node-status-success')).toHaveCount(3);

		await page.getByTestId('canvas-node').filter({ hasText: 'Code' }).dblclick();
		const output = page.getByTestId('output-panel');
		await expect(output.getByTestId('ndv-data-container')).toContainText('myNewField');
		await expect(output.getByTestId('ndv-data-container')).toContainText('hello from the browser');
		await context.close();
	});

	it('lists an execution and opens a past one', async () => {
		const id = await createWorkflow(
			'Executions list',
			[
				{
					name: 'Manual',
					type: 'n8n-nodes-base.manualTrigger',
					typeVersion: 1,
					position: [0, 0],
					parameters: {},
				},
				{
					name: 'Set',
					type: 'n8n-nodes-base.set',
					typeVersion: 3.4,
					position: [220, 0],
					parameters: {},
				},
			],
			{ Manual: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
		);
		const { page, context } = await signedInPage(browser, instance, 'executions');
		await page.goto(`/workflow/${id}`);
		await page.getByTestId('execute-workflow-button').click();
		await expect(page.getByTestId('canvas-node-status-success')).toHaveCount(2);

		await page.getByTestId('radio-button-executions').click();
		await page.waitForURL(/\/executions/);
		const rows = page
			.getByTestId('executions-sidebar')
			.locator('[data-test-id^="execution-details-"]');
		await expect(rows).toHaveCount(1);
		await expect(rows.first()).toContainText(/succeeded/i);

		await rows.first().click();
		const preview = page.getByTestId('execution-preview-host');
		await expect(preview).toBeVisible();
		await expect(page.locator('[data-test-id^="execution-preview-details-"]')).toBeVisible();
		await expect(preview.getByTestId('canvas-node')).toHaveCount(2);
		await expect(preview.getByTestId('canvas-node-status-success')).toHaveCount(2);

		// The global list shows the same execution.
		await page.goto('/home/executions');
		await expect(
			page.getByTestId('global-execution-list-item').filter({ hasText: 'Executions list' }),
		).toHaveCount(1);
		await context.close();
	});

	it('creates a Header Auth credential and lists it', async () => {
		const { page, context } = await signedInPage(browser, instance, 'credential');
		await page.goto('/home/credentials');
		await page
			.getByTestId('create-credential-button')
			.or(page.getByRole('button', { name: 'Create credential' }))
			.first()
			.click();
		await page.getByRole('combobox', { name: 'Search for app...' }).fill('Header Auth');
		await page
			.getByTestId('new-credential-type-select-option')
			.filter({ hasText: 'Header Auth' })
			.first()
			.click();
		await page.getByTestId('new-credential-type-button').click();

		const modal = page.getByTestId('editCredential-modal');
		await modal.getByTestId('parameter-input-name').locator('input').fill('X-Api-Key');
		await modal.getByTestId('parameter-input-value').locator('input').fill('super-secret-value');
		const saved = page.waitForResponse(
			(res) => /\/rest\/credentials$/.test(res.url()) && res.request().method() === 'POST',
		);
		await modal.getByTestId('credential-save-button').click();
		expect((await saved).status()).toBe(200);
		// The delete button shows once the editor has finished saving, so Escape does not hit a busy modal.
		await expect(modal.getByTestId('credential-delete-button')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(modal).toHaveCount(0);

		await expect(page.getByTestId('resources-list-item')).toHaveCount(1);
		await expect(page.getByTestId('resources-list-item')).toContainText('Header Auth account');
		// The list comes from the server: a reload keeps it, and the secret is not in the API response.
		await page.reload();
		await expect(page.getByTestId('resources-list-item')).toContainText('Header Auth account');
		const api = recordOf((await (await instance.ownerSession()).get('/rest/credentials')).body);
		expect(JSON.stringify(api)).not.toContain('super-secret-value');
		await context.close();
	});

	it('publishes a Webhook workflow and answers on the production URL', async () => {
		const id = await createWorkflow(
			'Published webhook',
			[
				{
					name: 'Webhook',
					type: 'n8n-nodes-base.webhook',
					typeVersion: 2,
					position: [0, 0],
					parameters: { path: 'e2e-published', httpMethod: 'GET' },
					webhookId: 'e2e-published-id',
				},
				{
					name: 'Set',
					type: 'n8n-nodes-base.set',
					typeVersion: 3.4,
					position: [220, 0],
					parameters: {},
				},
			],
			{ Webhook: { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
		);
		const url = `${instance.origin}/webhook/e2e-published`;
		expect((await fetch(url)).status).toBe(404);

		const { page, context } = await signedInPage(browser, instance, 'publish');
		await page.goto(`/workflow/${id}`);
		await page.getByTestId('workflow-open-publish-modal-button').click();
		await page.getByTestId('workflow-publish-button').click();
		await expect(page.getByRole('button', { name: 'Published' })).toBeVisible();

		const response = await fetch(url);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ message: 'Workflow was started' });
		await context.close();
	});

	it('shows node status live from push messages while a run is in progress', async () => {
		const id = await createWorkflow(
			'Live status',
			[
				{
					name: 'Manual',
					type: 'n8n-nodes-base.manualTrigger',
					typeVersion: 1,
					position: [0, 0],
					parameters: {},
				},
				{
					name: 'Wait',
					type: 'n8n-nodes-base.wait',
					typeVersion: 1.1,
					position: [220, 0],
					parameters: { amount: 4, unit: 'seconds' },
					webhookId: 'e2e-wait-id',
				},
				{
					name: 'Set',
					type: 'n8n-nodes-base.set',
					typeVersion: 3.4,
					position: [440, 0],
					parameters: {},
				},
			],
			{
				Manual: { main: [[{ node: 'Wait', type: 'main', index: 0 }]] },
				Wait: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
			},
		);
		const { page, context } = await signedInPage(browser, instance, 'push-live');
		const pushTypes: string[] = [];
		page.on('websocket', (ws) => {
			if (!ws.url().includes('/rest/push')) return;
			ws.on('framereceived', (frame) => {
				try {
					pushTypes.push(String(JSON.parse(String(frame.payload)).type));
				} catch {
					// Not a JSON frame.
				}
			});
		});
		await page.goto(`/workflow/${id}`);
		await page.getByTestId('execute-workflow-button').click();

		const wait = page.getByTestId('canvas-node').filter({ hasText: 'Wait' });
		// The Wait node is running while the run is still going, before any success status exists on it.
		await expect(wait.getByTestId('canvas-node-status-success')).toHaveCount(0);
		await expect(wait).toHaveClass(/running|waiting/);
		await expect(
			page
				.getByTestId('canvas-node')
				.filter({ hasText: 'Manual' })
				.getByTestId('canvas-node-status-success'),
		).toHaveCount(1);
		await expect(page.getByTestId('canvas-node-status-success')).toHaveCount(3);

		expect(pushTypes).toEqual(
			expect.arrayContaining([
				'executionStarted',
				'nodeExecuteBefore',
				'nodeExecuteAfter',
				'executionFinished',
			]),
		);
		expect(pushTypes.indexOf('nodeExecuteBefore')).toBeLessThan(
			pushTypes.lastIndexOf('executionFinished'),
		);
		await context.close();
	});
});
