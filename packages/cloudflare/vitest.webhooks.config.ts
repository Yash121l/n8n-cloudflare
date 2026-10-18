import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/webhooks/**/*.test.ts', 'test/triggers/**/*.test.ts'],
		globalSetup: ['test/webhooks/global-setup.ts'],
		testTimeout: 60_000,
		hookTimeout: 180_000,
		pool: 'forks',
		maxWorkers: 1,
	},
});
