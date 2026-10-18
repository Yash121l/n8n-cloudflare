import { build as esbuild } from 'esbuild';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { EXCLUDED_NODE_NAMES } from './unsupported-nodes.mjs';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, '..');
const monorepoPackages = path.resolve(packageRoot, '..');
// Node packages in stock load order. Each one prefixes the names of its nodes with its own name.
const PACKAGES = ['n8n-nodes-base', '@n8n/n8n-nodes-langchain'].map((name) => ({
	name,
	dir: path.dirname(require.resolve(`${name}/package.json`)),
}));
const editorDistDir = path.join(monorepoPackages, 'frontend/editor-ui/dist');
const cliDir = path.join(monorepoPackages, 'cli');
const outDir = path.join(packageRoot, 'dist/assets');

const REST_ENDPOINT = 'rest';
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_ASSET_FILES = 100_000;

// The tool variants that stock n8n generates from a node must go with that node.
const EXCLUDED_NODES = new Set(EXCLUDED_NODE_NAMES);

// Same rule as the stock `compileFile` in packages/cli/src/commands/start.ts.
const TEMPLATED_FILE = /(^|\/)index\.html$|\.(js|css)$/;
const SOURCE_MAP_FILE = /\.map$/;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function writeFile(file, content) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function walk(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? walk(full) : [full];
	});
}

// packages/cli/src/commands/start.ts `generateConfigTags`
function generateConfigTags(version) {
	const b64 = (value) => Buffer.from(value).toString('base64');
	const sentryConfig = JSON.stringify({
		dsn: '',
		environment: 'development',
		release: `n8n@${version}`,
	});
	return [
		`<meta name="n8n:config:rest-endpoint" content="${b64(REST_ENDPOINT)}">`,
		`<meta name="n8n:config:sentry" content="${b64(sentryConfig)}">`,
	].join('');
}

// packages/cli/src/commands/start.ts `generateStaticAssets`, with `path` = '/'.
// There is no CSP on Workers, so the per-request nonce placeholder becomes empty.
function templateFile(source, relativePath, configTags) {
	let text = source
		.replaceAll('%CONFIG_TAGS%', configTags)
		.replaceAll('/{{BASE_PATH}}/', '/')
		.replaceAll('/%7B%7BBASE_PATH%7D%7D/', '/')
		.replaceAll('/%257B%257BBASE_PATH%257D%257D/', '/');
	if (relativePath === 'index.html') {
		text = text.replaceAll('{{REST_ENDPOINT}}', REST_ENDPOINT).replaceAll('{{CSP_NONCE}}', '');
	}
	return text;
}

function copyEditor(version) {
	const configTags = generateConfigTags(version);
	for (const file of walk(editorDistDir)) {
		const relativePath = path.relative(editorDistDir, file).split(path.sep).join('/');
		if (SOURCE_MAP_FILE.test(relativePath)) continue;
		const dest = path.join(outDir, relativePath);
		if (TEMPLATED_FILE.test(relativePath)) {
			writeFile(dest, templateFile(readFileSync(file, 'utf8'), relativePath, configTags));
		} else {
			mkdirSync(path.dirname(dest), { recursive: true });
			copyFileSync(file, dest);
		}
	}
}

// The stock tool variant generators live in cli/src. Bundle them instead of copying the logic.
async function loadToolGeneration() {
	const tmpDir = path.join(packageRoot, 'dist/.build-assets-tmp');
	const bundle = path.join(tmpDir, 'tool-generation.cjs');
	await esbuild({
		entryPoints: [path.join(cliDir, 'src/tool-generation/index.ts')],
		outfile: bundle,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		external: ['n8n-workflow', 'n8n-core'],
		logLevel: 'warning',
	});
	const tools = require(bundle);
	rmSync(tmpDir, { recursive: true, force: true });
	return tools;
}

// packages/cli/src/load-nodes-and-credentials.ts `injectCustomApiCallOptions`
function injectCustomApiCallOptions(types) {
	const CUSTOM_API_CALL_NAME = 'Custom API Call';
	const CUSTOM_API_CALL_KEY = '__CUSTOM_API_CALL__';
	const findCredential = (name) => types.credentials.find((t) => t.name === name);

	const extendsProxyAuthBaseType = (credType, seen = new Set()) => {
		if (!Array.isArray(credType.extends)) return false;
		return credType.extends.some((parentName) => {
			if (['oAuth2Api', 'googleOAuth2Api', 'oAuth1Api'].includes(parentName)) return true;
			if (seen.has(parentName)) return false;
			seen.add(parentName);
			const parent = findCredential(parentName);
			return parent !== undefined && extendsProxyAuthBaseType(parent, seen);
		});
	};

	const supportsProxyAuth = (description) =>
		description.credentials?.some(({ name }) => {
			const credType = findCredential(name);
			if (!credType) return false;
			return credType.authenticate !== undefined || extendsProxyAuthBaseType(credType);
		}) ?? false;

	for (const node of types.nodes) {
		const isLatestVersion = node.defaultVersion === undefined || node.defaultVersion === node.version;
		if (!isLatestVersion || !supportsProxyAuth(node)) continue;
		for (const p of node.properties) {
			if (
				['resource', 'operation'].includes(p.name) &&
				Array.isArray(p.options) &&
				p.options[p.options.length - 1].name !== CUSTOM_API_CALL_NAME
			) {
				p.options.push({ name: CUSTOM_API_CALL_NAME, value: CUSTOM_API_CALL_KEY });
			}
		}
	}
}

// packages/cli/src/services/frontend.service.ts `getNodeVersionIdentifiers`
function getNodeVersionIdentifiers(nodes) {
	const identifiers = new Set();
	for (const node of nodes) {
		if (!node?.name || node.version === undefined) continue;
		const versions = Array.isArray(node.version) ? node.version : [node.version];
		for (const version of versions) identifiers.add(`${node.name}@${String(version)}`);
	}
	return [...identifiers];
}

// Mirrors `rebuildRegistry` in packages/cli/src/load-nodes-and-credentials.ts.
async function buildTypes() {
	const workflow = require('n8n-workflow');
	const tools = await loadToolGeneration();

	const types = { nodes: [], credentials: [] };
	const known = { nodes: {}, credentials: {} };
	for (const pkg of PACKAGES) {
		const prefix = (name) => `${pkg.name}.${name}`;
		const read = (file) => readJson(path.join(pkg.dir, 'dist', file));
		for (const node of read('types/nodes.json')) {
			types.nodes.push({ ...node, name: prefix(node.name) });
		}
		for (const credential of read('types/credentials.json')) {
			types.credentials.push({
				...credential,
				properties: workflow.injectDomainRestrictionFields(credential),
				supportedNodes: credential.supportedNodes?.map(prefix),
			});
		}
		for (const [name, entry] of Object.entries(read('known/nodes.json'))) {
			known.nodes[prefix(name)] = { ...entry, packageDir: pkg.dir };
		}
		for (const [name, entry] of Object.entries(read('known/credentials.json'))) {
			known.credentials[name] = { ...entry, supportedNodes: entry.supportedNodes?.map(prefix) };
		}
	}

	const baseNodeNames = Object.keys(known.nodes);

	tools.createAiTools(types, known);
	tools.createHitlTools(types, known);

	types.nodes = types.nodes.filter(({ name }) => !EXCLUDED_NODES.has(name));
	// The editor lists credentials by supportedNodes. Drop references to nodes that are not served.
	for (const credential of types.credentials) {
		credential.supportedNodes = credential.supportedNodes?.filter((name) => !EXCLUDED_NODES.has(name));
	}

	injectCustomApiCallOptions(types);

	return { types, known, baseNodeNames };
}

// One JSON entry for each line, like `writeStaticJSON` in frontend.service.ts.
const serializeTypes = (entries) =>
	`[\n${entries.map((entry) => JSON.stringify(entry)).join(',\n')}\n]\n`;

function iconUrlsOf(descriptions) {
	const urls = new Set();
	for (const { iconUrl } of descriptions) {
		if (!iconUrl) continue;
		if (typeof iconUrl === 'string') urls.add(iconUrl);
		else {
			urls.add(iconUrl.light);
			urls.add(iconUrl.dark);
		}
	}
	return urls;
}

// Stock serves `/icons/:packageName/*path/*file.(svg|png)` from the package directory, with
// a scoped name as `/icons/@scope/name/...` (packages/cli/src/server.ts, `resolveIcon`).
// Copy only the files that types reference.
function copyIcons(types) {
	const urls = iconUrlsOf([...types.nodes, ...types.credentials]);
	for (const url of urls) {
		const pkg = PACKAGES.find(({ name }) => url.startsWith(`icons/${name}/`));
		if (!pkg || !/\.(svg|png)$/.test(url)) {
			throw new Error(`Unexpected icon URL: ${url}`);
		}
		const source = path.join(pkg.dir, url.slice(`icons/${pkg.name}/`.length));
		if (!existsSync(source)) throw new Error(`Icon file is missing: ${source}`);
		const dest = path.join(outDir, url);
		mkdirSync(path.dirname(dest), { recursive: true });
		copyFileSync(source, dest);
	}
	return urls.size;
}

// Stock route: /schemas/:node/:version{/:resource}{/:operation}.json maps to
// <node dir>/__schema__/v<version>/<resource>/<operation>.json (`resolveOutputSchemaPath`).
// The editor removes `@n8n/` from the node name in the URL (schemaPreview.api.ts).
function copySchemas(known, baseNodeNames) {
	let count = 0;
	for (const name of baseNodeNames) {
		if (EXCLUDED_NODES.has(name)) continue;
		const { packageDir, sourcePath } = known.nodes[name];
		const nodeDir = path.dirname(path.join(packageDir, sourcePath));
		const schemaDir = path.join(nodeDir, '__schema__');
		if (!existsSync(schemaDir)) continue;
		for (const file of walk(schemaDir)) {
			const [versionDir, ...rest] = path.relative(schemaDir, file).split(path.sep);
			if (!/^v\d+\.\d+\.\d+$/.test(versionDir) || rest.length === 0) continue;
			const dest = path.join(outDir, 'schemas', name.replace('@n8n/', ''), versionDir.slice(1), ...rest);
			mkdirSync(path.dirname(dest), { recursive: true });
			copyFileSync(file, dest);
			count++;
		}
	}
	return count;
}

const HEADERS = `# Hashed build output never changes under the same URL.
/assets/*
  Cache-Control: public, max-age=31536000, immutable

# The HTML shell and the type files must revalidate on every load.
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/types/*
  Cache-Control: no-cache, must-revalidate

# Stock n8n caches these for one day.
/static/*
  Cache-Control: public, max-age=86400
/icons/*
  Cache-Control: public, max-age=86400
/schemas/*
  Cache-Control: public, max-age=86400
/favicon.ico
  Cache-Control: public, max-age=86400
`;

function reportStats() {
	const files = walk(outDir).map((file) => ({ file, size: statSync(file).size }));
	const largest = files.reduce((a, b) => (b.size > a.size ? b : a));
	if (files.length >= MAX_ASSET_FILES) {
		throw new Error(`Too many asset files: ${files.length}`);
	}
	if (largest.size > MAX_ASSET_BYTES) {
		throw new Error(`Asset is larger than 25 MiB: ${largest.file}`);
	}
	const total = files.reduce((sum, f) => sum + f.size, 0);
	return { count: files.length, total, largest };
}

async function main() {
	if (!existsSync(path.join(editorDistDir, 'index.html'))) {
		throw new Error(`Editor is not built: ${editorDistDir}`);
	}
	const version = readJson(path.join(cliDir, 'package.json')).version;

	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });

	copyEditor(version);

	const { types, known, baseNodeNames } = await buildTypes();
	writeFile(path.join(outDir, 'types/nodes.json'), serializeTypes(types.nodes));
	writeFile(
		path.join(outDir, 'types/node-versions.json'),
		serializeTypes(getNodeVersionIdentifiers(types.nodes)),
	);
	writeFile(path.join(outDir, 'types/credentials.json'), serializeTypes(types.credentials));

	const iconCount = copyIcons(types);
	const schemaCount = copySchemas(known, baseNodeNames);
	writeFile(path.join(outDir, '_headers'), HEADERS);

	const stats = reportStats();
	const mib = (bytes) => (bytes / 1024 / 1024).toFixed(2);
	console.log(
		`assets: ${stats.count} files, ${mib(stats.total)} MiB, largest ${path.relative(outDir, stats.largest.file)} (${mib(stats.largest.size)} MiB)`,
	);
	console.log(
		`types: ${types.nodes.length} nodes, ${types.credentials.length} credentials, ${iconCount} icons, ${schemaCount} schemas`,
	);
}

await main();
