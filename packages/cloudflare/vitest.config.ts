import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		// These suites need their own workers and setup, see vitest.webhooks.config.ts and vitest.assets.config.ts.
		exclude: ['test/webhooks/**', 'test/triggers/**', 'test/assets/**', '**/node_modules/**'],
		globalSetup: ['test/api/global-setup.ts'],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		pool: 'forks',
		// Every test file starts its own workerd, so too many at once slows the first request.
		maxWorkers: 4,
	},
});
