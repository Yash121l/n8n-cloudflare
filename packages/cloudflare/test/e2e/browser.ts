import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, selectors } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { expect as playwrightExpect } from 'playwright/test';
import { onTestFailed } from 'vitest';

import { OWNER } from '../api/harness';
import type { Instance } from '../api/harness';

// The editor marks elements with data-test-id, not Playwright's default data-testid.
selectors.setTestIdAttribute('data-test-id');

/** Playwright's `expect` has the locator matchers. The editor is slow on first paint, so waits are generous. */
export const expect = playwrightExpect.configure({ timeout: 30_000 });

export const ARTIFACTS = join(import.meta.dirname, 'artifacts');

export async function launch(): Promise<Browser> {
	return await chromium.launch({ headless: true });
}

/**
 * A fresh browser context with its own page. Call inside a test: on failure it saves a screenshot,
 * the page URL and the browser console to test/e2e/artifacts.
 */
export async function newPage(
	browser: Browser,
	instance: Instance,
	name: string,
): Promise<{ context: BrowserContext; page: Page; console: string[] }> {
	const context = await browser.newContext({
		baseURL: instance.origin,
		viewport: { width: 1600, height: 1000 },
	});
	context.setDefaultTimeout(30_000);
	const page = await context.newPage();
	const logs: string[] = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error' || msg.type() === 'warning')
			logs.push(`[${msg.type()}] ${msg.text()}`);
	});
	page.on('response', (res) => {
		const type = res.request().resourceType();
		if (
			res.status() >= 400 ||
			(type === 'script' && (res.headers()['content-type'] ?? '').includes('html'))
		) {
			logs.push(`[http ${res.status()}] ${type} ${res.url()}`);
		}
	});
	page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
	onTestFailed(async () => {
		mkdirSync(ARTIFACTS, { recursive: true });
		const file = join(ARTIFACTS, `${name.replace(/[^a-z0-9]+/gi, '-')}.png`);
		await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
		console.error(`screenshot: ${file}\nurl: ${page.url()}\n${logs.slice(-20).join('\n')}`);
	});
	return { context, page, console: logs };
}

/** Logs in through the real sign-in form. */
export async function loginViaForm(page: Page) {
	await page.goto('/signin');
	await page.getByRole('textbox', { name: 'Email' }).fill(OWNER.email);
	await page.getByRole('textbox', { name: 'Password' }).fill(OWNER.password);
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await page.waitForURL((url) => !url.pathname.startsWith('/signin'));
}

/** A page that is already signed in as the owner, for tests that are not about the sign-in form. */
export async function signedInPage(browser: Browser, instance: Instance, name: string) {
	const session = await instance.ownerSession();
	const result = await newPage(browser, instance, name);
	const [cookieName, ...rest] = session.cookieHeader.split('=');
	await result.context.addCookies([
		{ name: cookieName, value: rest.join('='), url: instance.origin, httpOnly: true },
	]);
	return result;
}

/** Adds a node through the node creator. `pick` is the exact text of the item to click in the list. */
export async function addNode(
	page: Page,
	search: string,
	pick: string,
	options: { first?: boolean; action?: string } = {},
) {
	await page.getByTestId(options.first ? 'canvas-plus-button' : 'node-creator-plus-button').click();
	await page.getByTestId('node-creator-search-bar').fill(search);
	await page.getByTestId('node-creator-item-name').getByText(pick, { exact: true }).first().click();
	if (options.action)
		await page
			.getByTestId('node-creator-item-name')
			.getByText(options.action, { exact: true })
			.click();
}
