import { defineConfig } from 'vitest/config';

// Browser tests: Playwright drives the real editor from dist/assets (run `pnpm build:assets` first)
// against a worker started by the API harness.
export default defineConfig({
	test: {
		include: ['test/e2e/**/*.e2e.ts'],
		globalSetup: ['test/e2e/global-setup.ts'],
		testTimeout: 120_000,
		hookTimeout: 180_000,
		pool: 'forks',
		fileParallelism: false,
		maxWorkers: 1,
	},
});
