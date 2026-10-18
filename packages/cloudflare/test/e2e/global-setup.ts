import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

import setupApi from '../api/global-setup';

const root = resolve(import.meta.dirname, '../..');

/** Same build and migrated D1 snapshot as the API tests, but serving the real editor build as Static Assets. */
export default function setup(project: TestProject) {
	const assets = join(root, 'dist/assets');
	if (!existsSync(join(assets, 'index.html')))
		throw new Error('dist/assets is missing, run `pnpm build:assets` first');

	let harnessDir = '';
	const teardown = setupApi({
		provide: (key: 'harnessDir', value: string) => {
			harnessDir = value;
			project.provide(key, value);
		},
	} as unknown as TestProject);

	const configPath = join(harnessDir, 'wrangler.jsonc');
	const config = JSON.parse(readFileSync(configPath, 'utf8'));
	config.assets.directory = assets;
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	return teardown;
}
