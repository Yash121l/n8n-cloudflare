import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '../..');
const assetsDir = path.join(packageRoot, 'dist/assets');

const EXCLUDED_NODES = [
	'n8n-nodes-base.e2eTest',
	...['code', 'vectorStoreMilvus', 'vectorStoreWeaviate', 'mcpTrigger'].map(
		(name) => `@n8n/n8n-nodes-langchain.${name}`,
	),
];
const NODE_NAME = /^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\.\w+$/;

const TEXT_FILE = /\.(html|js|css|json|svg|txt)$/;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILE_COUNT = 100_000;

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? walk(full) : [full];
	});
}

const readJson = <T>(relativePath: string) =>
	JSON.parse(readFileSync(path.join(assetsDir, relativePath), 'utf8')) as T;

interface IconUrl {
	light: string;
	dark: string;
}
interface Described {
	name: string;
	iconUrl?: string | IconUrl;
	supportedNodes?: string[];
	credentials?: Array<{ name: string }>;
	outputs?: unknown;
}

const iconUrlsOf = (items: Described[]) =>
	items.flatMap(({ iconUrl }) => {
		if (!iconUrl) return [];
		return typeof iconUrl === 'string' ? [iconUrl] : [iconUrl.light, iconUrl.dark];
	});

let files: string[];
let nodes: Described[];
let credentials: Described[];

beforeAll(() => {
	execFileSync('node', ['scripts/build-assets.mjs'], { cwd: packageRoot, stdio: 'pipe' });
	files = walk(assetsDir);
	nodes = readJson<Described[]>('types/nodes.json');
	credentials = readJson<Described[]>('types/credentials.json');
});

describe('editor files', () => {
	it('leaves no template placeholder in any text file', () => {
		const placeholders = [
			'%CONFIG_TAGS%',
			'{{BASE_PATH}}',
			'%7B%7BBASE_PATH%7D%7D',
			'%257B%257BBASE_PATH%257D%257D',
			'{{REST_ENDPOINT}}',
			'{{CSP_NONCE}}',
		];
		const offenders = files
			.filter((file) => TEXT_FILE.test(file))
			.flatMap((file) => {
				const text = readFileSync(file, 'utf8');
				return placeholders.filter((p) => text.includes(p)).map((p) => `${file}: ${p}`);
			});
		expect(offenders).toEqual([]);
	});

	it('renders index.html with root-relative asset URLs and config tags', () => {
		const html = readFileSync(path.join(assetsDir, 'index.html'), 'utf8');
		expect(html).toContain('src="/static/base-path.js"');
		expect(html).toContain('href="/static/prefers-color-scheme.css"');
		expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js"/);

		const restEndpoint = /name="n8n:config:rest-endpoint" content="([^"]+)"/.exec(html)?.[1];
		expect(Buffer.from(restEndpoint ?? '', 'base64').toString()).toBe('rest');
		expect(html).toContain('name="n8n:config:sentry"');

		const references = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
		expect(references.length).toBeGreaterThan(5);
		for (const reference of references) {
			expect(existsSync(path.join(assetsDir, reference)), reference).toBe(true);
		}
	});

	it('sets the base path to the root', () => {
		const script = readFileSync(path.join(assetsDir, 'static/base-path.js'), 'utf8');
		expect(script).toMatch(/window\.BASE_PATH\s*=\s*'\/'/);
	});
});

describe('type files', () => {
	it('lists prefixed node types and none of the excluded ones', () => {
		expect(Array.isArray(nodes)).toBe(true);
		expect(nodes.length).toBeGreaterThan(300);
		for (const { name } of nodes) expect(name).toMatch(NODE_NAME);

		const names = new Set(nodes.map(({ name }) => name));
		for (const excluded of EXCLUDED_NODES) {
			expect(names.has(excluded), excluded).toBe(false);
			expect(names.has(`${excluded}Tool`), `${excluded}Tool`).toBe(false);
		}
		expect(names.has('n8n-nodes-base.httpRequest')).toBe(true);
		expect(names.has('n8n-nodes-base.convertToFile')).toBe(true);
		expect(names.has('n8n-nodes-base.slackTool')).toBe(true);
		for (const name of ['kafka', 'kafkaTrigger', 'rabbitmq', 'rabbitmqTrigger', 'snowflake']) {
			expect(names.has(`n8n-nodes-base.${name}`), name).toBe(true);
		}
	});

	it('lists the langchain nodes and their tool variants', () => {
		const names = new Set(nodes.map(({ name }) => name));
		const langchain = [...names].filter((name) => name.startsWith('@n8n/n8n-nodes-langchain.'));
		expect(langchain.length).toBeGreaterThan(110);
		for (const name of [
			'agent',
			'lmChatOpenAi',
			'lmChatAnthropic',
			'toolCalculator',
			'toolCode',
			'vectorStoreInMemory',
		]) {
			expect(names.has(`@n8n/n8n-nodes-langchain.${name}`), name).toBe(true);
		}
		// Real tool nodes and tool variants made from usableAsTool nodes.
		expect(names.has('@n8n/n8n-nodes-langchain.agentTool')).toBe(true);
		expect(names.has('@n8n/n8n-nodes-langchain.anthropicTool')).toBe(true);
		const anthropicTool = nodes.find(
			({ name }) => name === '@n8n/n8n-nodes-langchain.anthropicTool',
		);
		expect(anthropicTool?.outputs).toEqual(['ai_tool']);
	});

	it('finds every credential that a node uses', () => {
		const credentialNames = new Set(credentials.map(({ name }) => name));
		const missing = nodes.flatMap(({ name, credentials: used = [] }) =>
			used.filter((c) => !credentialNames.has(c.name)).map((c) => `${name} -> ${c.name}`),
		);
		expect(missing).toEqual([]);
		expect(credentialNames.has('anthropicApi')).toBe(true);
		const anthropic = credentials.find(({ name }) => name === 'anthropicApi');
		expect(anthropic?.supportedNodes).toContain('@n8n/n8n-nodes-langchain.lmChatAnthropic');
	});

	it('lists credential types that point at served nodes', () => {
		expect(Array.isArray(credentials)).toBe(true);
		expect(credentials.length).toBeGreaterThan(300);
		const names = new Set(nodes.map(({ name }) => name));
		const dangling = credentials.flatMap(({ name, supportedNodes = [] }) =>
			supportedNodes.filter((node) => !names.has(node)).map((node) => `${name} -> ${node}`),
		);
		expect(dangling).toEqual([]);
	});

	it('lists a name@version identifier for every node version', () => {
		const versions = readJson<string[]>('types/node-versions.json');
		expect(versions).toContain('n8n-nodes-base.httpRequest@4.2');
		expect(new Set(versions).size).toBe(versions.length);
		expect(versions).toContain('@n8n/n8n-nodes-langchain.agent@3.1');
		for (const identifier of versions)
			expect(identifier).toMatch(/^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\.\w+@[\d.]+$/);
	});

	it('resolves every icon URL to a file in the assets', () => {
		const urls = iconUrlsOf([...nodes, ...credentials]);
		expect(urls.length).toBeGreaterThan(300);
		for (const url of urls) {
			expect(url).toMatch(
				/^icons\/(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\/dist\/.+\.(svg|png)$/,
			);
			expect(existsSync(path.join(assetsDir, url)), url).toBe(true);
		}
		const dark = nodes.filter(({ iconUrl }) => typeof iconUrl === 'object');
		expect(dark.length).toBeGreaterThan(0);
		expect(
			urls.filter((url) => url.startsWith('icons/@n8n/n8n-nodes-langchain/')).length,
		).toBeGreaterThan(50);
	});

	it('serves langchain output schemas under the name without @n8n/, like the editor asks', () => {
		const schemaDirs = readdirSync(path.join(assetsDir, 'schemas'));
		expect(schemaDirs).toContain('n8n-nodes-langchain.agent');
		expect(schemaDirs.filter((dir) => dir.startsWith('@'))).toEqual([]);
		const agentVersions = readdirSync(path.join(assetsDir, 'schemas/n8n-nodes-langchain.agent'));
		expect(agentVersions.length).toBeGreaterThan(0);
	});
});

describe('output limits', () => {
	it('stays within the Cloudflare Static Assets limits', () => {
		expect(files.length).toBeLessThan(MAX_FILE_COUNT);
		const tooBig = files.filter((file) => statSync(file).size > MAX_FILE_BYTES);
		expect(tooBig).toEqual([]);
	});

	it('drops source maps', () => {
		expect(files.filter((file) => file.endsWith('.map'))).toEqual([]);
	});

	it('writes cache headers', () => {
		const headers = readFileSync(path.join(assetsDir, '_headers'), 'utf8');
		expect(headers).toMatch(/\/assets\/\*\n\s+Cache-Control: .*immutable/);
		expect(headers).toMatch(/\/types\/\*\n\s+Cache-Control: no-cache/);
		expect(headers).toMatch(/\/index\.html\n\s+Cache-Control: no-cache/);
	});
});
