import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

const root = resolve(import.meta.dirname, '../..');

declare module 'vitest' {
	export interface ProvidedContext {
		/** Directory with a wrangler config, the built worker and a migrated D1 snapshot. */
		harnessDir: string;
	}
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, ...env },
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`.slice(0, 4000),
		);
	}
}

/** Builds the worker once into a private directory, so concurrent builds elsewhere cannot break the tests. */
export default function setup(project: TestProject) {
	const harnessDir = mkdtempSync(join(tmpdir(), 'n8n-cf-test-'));
	const workerDir = join(harnessDir, 'worker');
	const assetsDir = join(harnessDir, 'assets');
	mkdirSync(assetsDir, { recursive: true });
	writeFileSync(join(assetsDir, 'index.html'), '<!doctype html><title>n8n</title>');

	run('node', ['scripts/build-sandbox.mjs'], root);

	run('node', ['build.mjs', 'src/index.ts', workerDir], root);

	const base = JSON.parse(
		readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
			.split('\n')
			.filter((line) => !line.trim().startsWith('//'))
			.join('\n'),
	);
	const config = {
		...base,
		$schema: undefined,
		main: join(workerDir, 'index.js'),
		base_dir: workerDir,
		assets: { ...base.assets, directory: assetsDir },
		d1_databases: base.d1_databases.map((db: Record<string, unknown>) => ({
			...db,
			migrations_dir: join(root, 'migrations'),
		})),
	};
	writeFileSync(join(harnessDir, 'wrangler.jsonc'), JSON.stringify(config, null, 2));

	const snapshot = join(harnessDir, 'snapshot');
	run(
		join(root, 'node_modules/.bin/wrangler'),
		[
			'd1',
			'migrations',
			'apply',
			'DB',
			'--local',
			'--persist-to',
			snapshot,
			'--config',
			join(harnessDir, 'wrangler.jsonc'),
		],
		root,
		{ WRANGLER_LOG_PATH: join(harnessDir, 'logs') },
	);
	if (!existsSync(snapshot)) throw new Error('migration snapshot was not created');

	project.provide('harnessDir', harnessDir);
	return () => {
		// Each build is about 300 MB. Set N8N_CF_KEEP_TEST_DIR to inspect a failed run.
		if (!process.env.N8N_CF_KEEP_TEST_DIR) rmSync(harnessDir, { recursive: true, force: true });
	};
}
