import { builtinModules } from 'node:module';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

// Imports of these modules resolve to a stub that throws when it is used.
export const BASE_STUBS = [
	/^@sentry\//,
	/^ssh2$/,
	/^ssh2-sftp-client$/,
	/^cpu-features$/,
	/^isolated-vm$/,
	/^vm2$/,
	/^fast-glob$/,
];

// @n8n/n8n-nodes-langchain pulls these in. They are native, need a filesystem, or run
// `new Function` at load (protobufjs in the Milvus SDK). Optional peers are not installed.
export const LANGCHAIN_STUBS = [
	/^@zilliz\/milvus2-sdk-node(\/|$)/,
	/^@n8n\/typeorm(\/|$)/,
	/^typeorm(\/|$)/,
	/^app-root-path$/,
	/^sqlite3$/,
	/^bindings$/,
	/^@chroma-core\/default-embed$/,
	/^@mongodb-js\/zstd$/,
	/^canvas$/,
	/^kerberos$/,
	/^mongodb-client-encryption$/,
	/^snappy$/,
	/^word-extractor$/,
	/^zipfile$/,
];

const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const throwingProxy = (name) => {
	const message = JSON.stringify(`${name} is not available on Cloudflare Workers`);
	return `module.exports = new Proxy(function () {}, {
		get(_, key) {
			if (key === '__esModule') return false;
			if (key === 'then') return undefined;
			return () => { throw new Error(${message}); };
		},
		apply() { throw new Error(${message}); },
		construct() { throw new Error(${message}); },
	});`;
};

function workersCompat(stubs) {
	return {
		name: 'workers-compat',
		setup(build) {
			// n8n packages point "module"/"import" at TS sources; built CJS keeps decorator metadata and
			// gives ESM and CJS importers the same module instance.
			build.onResolve({ filter: /^(@n8n\/[^/]+|n8n-(workflow|core|nodes-base))(\/.*)?$/ }, (args) => {
				if (args.kind === 'require-call' || stubs.some((re) => re.test(args.path))) return undefined;
				return build.resolve(args.path, { kind: 'require-call', resolveDir: args.resolveDir });
			});
			build.onResolve({ filter: /^cloudflare:/ }, (args) => ({ path: args.path, external: true }));
			build.onResolve({ filter: /.*/ }, (args) => {
				if (stubs.some((re) => re.test(args.path))) {
					return { path: args.path, namespace: 'unavailable' };
				}
				if (builtins.has(args.path)) {
					const name = args.path.startsWith('node:') ? args.path : `node:${args.path}`;
					if (args.kind === 'require-call') return { path: name, namespace: 'builtin-cjs' };
					return { path: name, external: true };
				}
				return undefined;
			});
			build.onLoad({ filter: /\.node$/ }, (args) => ({
				contents: `throw new Error(${JSON.stringify(`native addon ${args.path} is not available on Cloudflare Workers`)});`,
				loader: 'js',
			}));
			build.onLoad({ filter: /.*/, namespace: 'unavailable' }, (args) => ({
				contents: throwingProxy(args.path),
				loader: 'js',
			}));
			build.onLoad({ filter: /.*/, namespace: 'builtin-cjs' }, (args) => ({
				contents: `import * as m from ${JSON.stringify(args.path)}; module.exports = m.default ?? m;`,
				loader: 'js',
			}));
		},
	};
}

/**
 * nodes-base Code/JavaScriptSandbox calls `makeResolverFromLegacyOptions` at load. Stub vm2 so that
 * modules which import it still load, and only creating a VM throws.
 */
export const vm2Stub = {
	name: 'vm2-stub',
	setup(build) {
		build.onResolve({ filter: /^vm2$/ }, () => ({ path: 'vm2', namespace: 'vm2-stub' }));
		build.onLoad({ filter: /.*/, namespace: 'vm2-stub' }, () => ({
			loader: 'js',
			contents: `const fail = () => { throw new Error('vm2 is not available on Cloudflare Workers'); };
			exports.NodeVM = class { constructor() { fail(); } };
			exports.VM = class { constructor() { fail(); } };
			exports.VMScript = class { constructor() { fail(); } };
			exports.makeResolverFromLegacyOptions = () => undefined;
			exports.makeNodeResolver = () => undefined;`,
		}));
	},
};

const PINNED_FUNCTIONS = ['getInputs', 'configuredInputs', 'configuredOutputs', 'getOutputs'];

function functionSource(text, start) {
	let depth = 0;
	let quote = null;
	for (let i = text.indexOf('{', start); i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === '\\') i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') quote = c;
		else if (c === '/' && text[i + 1] === '/') i = text.indexOf('\n', i);
		else if (c === '/' && text[i + 1] === '*') i = text.indexOf('*/', i) + 1;
		else if (c === '{') depth++;
		else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
	}
	throw new Error('Function has no closing brace');
}

/**
 * Langchain node descriptions embed `getInputs.toString()` into expressions and then call
 * `getInputs` by name. The minifier renames the function and keepNames adds `__name` calls, so
 * the expression fails. This pins `toString` to the source text before the bundler changes it.
 */
export const pinFunctionSource = {
	name: 'pin-function-source',
	setup(build) {
		build.onLoad({ filter: /nodes-langchain\/dist\/nodes\/.*\.js$/ }, (args) => {
			const text = readFileSync(args.path, 'utf8');
			const pins = [];
			for (const name of PINNED_FUNCTIONS) {
				const match = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(text);
				if (!match) continue;
				const source = functionSource(text, match.index);
				new Function(`return (${source})`);
				pins.push(`${name}.toString = () => ${JSON.stringify(source)};`);
			}
			if (pins.length === 0) return undefined;
			return { contents: `${text}\n${pins.join('\n')}\n`, loader: 'js', resolveDir: path.dirname(args.path) };
		});
	},
};

/**
 * Small source swaps that let socket clients run on workerd's node:net and node:tls, without
 * forking the libraries:
 * - mqtt decides it runs in a browser when `self` is a WorkerGlobalScope, and then speaks MQTT over
 *   WebSockets. On Workers it must use its Node transport (node:net / node:tls).
 * - amqplib parses frames with @acuminous/bitsyntax matchers compiled by `new Function`, which
 *   Workers forbid. The library has interpreted equivalents that produce the same results.
 * - snowflake-sdk sends HTTP through axios with Node agents that check certificates on the raw
 *   socket. On Workers its axios instance uses the fetch adapter instead, and fetch checks TLS.
 *   It also passes `null` zlib options, which workerd rejects, and reads `__dirname` to find an
 *   optional config file. `open` (for browser SSO) cannot work on Workers and fails at load.
 * - The v2 Kafka nodes load @confluentinc/kafka-javascript, a native librdkafka addon. Its
 *   KafkaJS-compatible API is provided by src/runtime/shims/kafka-javascript.ts on kafkajs.
 * - @kafkajs/confluent-schema-registry loads avsc, which compiles Avro codecs with `new Function`
 *   when it loads. The Kafka nodes import it at the top of the file, so they could not load at all.
 *   A stub takes its place. Only the "Use Schema Registry" option then fails, with a clear message.
 * - imapflow restarts its response reader on the next 'readable' event. Node runs
 *   process.nextTick before promise callbacks, so that event always finds the reader stopped.
 *   workerd runs nextTick as a microtask, so the event can come first and is lost, and the
 *   connection stalls. The patch checks for buffered responses when the reader stops.
 */
const SOURCE_PATCHES = [
	{
		file: /[\\/]imapflow[\\/]lib[\\/]imap-flow\.js$/,
		replace: [
			[
				`                    .finally(() => {
                        this.reading = false;
                    });`,
				`                    .finally(() => {
                        this.reading = false;
                        if (this.streamer && !this.streamer.destroyed && this.streamer.readableLength > 0) this.socketReadable();
                    });`,
			],
		],
	},
	{
		file: /[\\/]snowflake-sdk[\\/]dist[\\/]lib[\\/]http[\\/]axios_instance\.js$/,
		// workerd rejects the default `cache: 'default'` request option of the axios fetch adapter.
		replace: [['axios_1.default.create()', "axios_1.default.create({ adapter: 'fetch', fetchOptions: { cache: 'no-store' } })"]],
	},
	{
		file: /[\\/]snowflake-sdk[\\/]dist[\\/]lib[\\/]http[\\/]base\.js$/,
		replace: [
			// Node finishes the async gzip after the request is sent, so the body goes out plain. On
			// workerd the callback can run first and add a gzip header to a plain body. Sync gzip
			// sends the compressed body and its header together.
			[
				'zlib.gzip(bufferUncompressed, null, function (err, bufferCompressed) {',
				'(function (callback) { let compressed; try { compressed = zlib.gzipSync(bufferUncompressed); } catch (error) { return callback(error); } callback(null, compressed); })(function (err, bufferCompressed) {',
			],
			// The fetch adapter does not use Node agents, and workerd cannot construct the SDK's OCSP agent.
			['const agent = this.getAgent(url, this._connectionConfig.getProxy(), mock);', 'const agent = undefined;'],
		],
	},
	{
		// The SDK probes cloud metadata endpoints once, from a promise made when the module loads. On
		// Workers, a later request cannot await I/O that an earlier request started, so every login
		// waited forever. This is the same as SNOWFLAKE_DISABLE_PLATFORM_DETECTION=true.
		file: /[\\/]snowflake-sdk[\\/]dist[\\/]lib[\\/]telemetry[\\/]platform_detection\.js$/,
		replace: [['const DETECTION_RESULT = detectPlatforms();', "const DETECTION_RESULT = Promise.resolve(['disabled']);"]],
	},
	{
		file: /[\\/]snowflake-sdk[\\/]dist[\\/]lib[\\/]util\.js$/,
		replace: [['"use strict";', '"use strict";\nvar __dirname = "/";']],
	},
];

export const socketShims = {
	name: 'socket-shims',
	setup(build) {
		// The native librdkafka binding of the v2 Kafka nodes cannot load. A kafkajs adapter replaces it.
		build.onResolve({ filter: /^@confluentinc\/kafka-javascript$/ }, () => ({
			path: new URL('./src/runtime/shims/kafka-javascript.ts', import.meta.url).pathname,
		}));
		build.onResolve({ filter: /^@kafkajs\/confluent-schema-registry$/ }, (args) => ({
			path: args.path,
			namespace: 'schema-registry-stub',
		}));
		build.onLoad({ filter: /.*/, namespace: 'schema-registry-stub' }, () => ({
			loader: 'js',
			contents: `export class SchemaRegistry {
				constructor() {
					throw new Error('The Confluent Schema Registry is not available on Cloudflare Workers. Its Avro library compiles code at run time, which Workers do not allow. Turn off "Use Schema Registry".');
				}
			}`,
		}));
		build.onResolve({ filter: /^open$/ }, (args) =>
			/[\\/]snowflake-sdk[\\/]/.test(args.importer) ? { path: args.path, namespace: 'unavailable' } : undefined,
		);
		for (const patch of SOURCE_PATCHES)
			build.onLoad({ filter: patch.file }, (args) => {
				let source = readFileSync(args.path, 'utf8');
				for (const [from, to] of patch.replace) {
					if (!source.includes(from)) throw new Error(`socket-shims: ${args.path} changed, update the patch`);
					source = source.replace(from, to);
				}
				return { loader: 'js', resolveDir: path.dirname(args.path), contents: source };
			});
		build.onLoad({ filter: /[\\/]mqtt[\\/]build[\\/]lib[\\/]is-browser\.js$/ }, () => ({
			loader: 'js',
			contents: `"use strict";
			Object.defineProperty(exports, "__esModule", { value: true });
			exports.isReactNativeBrowser = false;
			exports.isWebWorker = false;
			exports.default = false;`,
		}));
		build.onLoad({ filter: /[\\/]@acuminous[\\/]bitsyntax[\\/]lib[\\/]compile\.js$/ }, (args) => ({
			loader: 'js',
			resolveDir: path.dirname(args.path),
			contents: `"use strict";
			const { parse } = require('./parse');
			const { match } = require('./interp');
			const { build } = require('./constructor');
			const join = (args) => [].join.call(args, ',');
			const matcherOf = (pattern) => (binary, env) => match(pattern, binary, env);
			module.exports.compile_pattern = matcherOf;
			module.exports.compile = function () { return matcherOf(parse(join(arguments))); };
			module.exports.compile_builder = function () {
				const pattern = parse(join(arguments));
				return (bindings) => build(pattern, bindings);
			};`,
		}));
	},
};

export const WORKER_STUBS = [...BASE_STUBS.filter((re) => re.source !== '^vm2$'), ...LANGCHAIN_STUBS];
export const WORKER_PLUGINS = [vm2Stub, pinFunctionSource, socketShims];

export async function bundle({ entry, outfile, outdir, metafile, external = [], stubs = BASE_STUBS, plugins = [] }) {
	if (outdir) rmSync(outdir, { recursive: true, force: true });
	const result = await esbuild.build({
		entryPoints: [entry],
		external,
		...(outdir ? { outdir, splitting: true, chunkNames: 'chunks/[name]-[hash]' } : { outfile }),
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'es2024',
		conditions: ['workerd', 'worker'],
		mainFields: ['main', 'module'],
		// Pin one tsconfig: package tsconfigs map @n8n/* to src, which loses decorator metadata.
		tsconfig: new URL('./tsconfig.json', import.meta.url).pathname,
		minify: !process.env.NO_MINIFY,
		keepNames: true,
		sourcemap: 'external',
		metafile: Boolean(metafile),
		logLevel: 'warning',
		logOverride: { 'package.json': 'silent', 'empty-import-meta': 'silent' },
		define: { 'process.env.NODE_ENV': '"production"' },
		plugins: [...plugins, workersCompat(stubs)],
	});
	if (metafile) writeFileSync(metafile, JSON.stringify(result.metafile));
	return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [entry, out, metafile] = process.argv.slice(2);
	const options = { entry, metafile, stubs: WORKER_STUBS, plugins: WORKER_PLUGINS };
	await bundle(out.endsWith('.js') ? { ...options, outfile: out } : { ...options, outdir: out });
}
