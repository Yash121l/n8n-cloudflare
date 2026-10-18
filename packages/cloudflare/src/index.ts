import { createApp } from './api/app';
import type { Env } from './env';
import { pruneExecutions } from './execution/store';

export { PushHub } from './push/push-hub';
export { TriggerScheduler } from './triggers/trigger-scheduler';
export { TriggerConnection } from './triggers/trigger-connection';
export { ExecutionWorkflow } from './execution/execution-workflow';
export { ExecutionRunner } from './execution/execution-runner';

const app = createApp();

export default {
	fetch: (request, env, ctx) => app.fetch(request, env, ctx),
	scheduled: (_controller, env, ctx) => {
		ctx.waitUntil(pruneExecutions(env));
	},
} satisfies ExportedHandler<Env>;
