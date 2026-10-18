import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

const root = resolve(import.meta.dirname, '../..');

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, ...env },
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0)
		throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`.slice(-6000));
}

export default function setup(project: TestProject) {
	const directory = mkdtempSync(join(tmpdir(), 'n8n-webhooks-'));
	const worker = join(directory, 'worker');
	const assets = join(directory, 'assets');
	mkdirSync(assets);
	writeFileSync(join(assets, 'index.html'), '<!doctype html><title>n8n</title>');
	run('node', ['scripts/build-sandbox.mjs']);

	run('node', ['build.mjs', 'test/webhooks/worker.ts', worker]);
	const base = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
	writeFileSync(
		join(directory, 'wrangler.jsonc'),
		JSON.stringify({
			...base,
			$schema: undefined,
			main: join(worker, 'worker.js'),
			base_dir: worker,
			assets: { ...base.assets, directory: assets, run_worker_first: true },
			d1_databases: base.d1_databases.map((db: Record<string, unknown>) => ({
				...db,
				migrations_dir: join(root, 'migrations'),
			})),
		}),
	);
	run(
		join(root, 'node_modules/.bin/wrangler'),
		[
			'd1',
			'migrations',
			'apply',
			'DB',
			'--local',
			'--persist-to',
			join(directory, 'snapshot'),
			'--config',
			join(directory, 'wrangler.jsonc'),
		],
		{ WRANGLER_LOG_PATH: join(directory, 'logs') },
	);
	project.provide('harnessDir', directory);
	return () => {
		if (!process.env.N8N_CF_KEEP_TEST_DIR) rmSync(directory, { recursive: true, force: true });
	};
}
