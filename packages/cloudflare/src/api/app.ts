import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { authMiddleware } from '../auth/middleware';
import type { UserRow } from '../db/types';
import type { Env } from '../env';
import type { RunContext } from '../runtime/service';
import { HttpError } from './errors';
import { annotationTagRoutes } from './routes/annotation-tags';
import { authRoutes } from './routes/auth';
import { binaryDataRoutes, signedBinaryDataRoutes } from './routes/binary-data';
import { credentialRoutes } from './routes/credentials';
import { dynamicParameterRoutes } from './routes/dynamic-parameters';
import { executionRoutes } from './routes/executions';
import { nodeTypeRoutes } from './routes/node-types';
import { oauthRoutes } from './routes/oauth';
import { projectRoutes } from './routes/projects';
import { pushRoutes } from './routes/push';
import { settingsRoutes } from './routes/settings';
import { stubRoutes } from './routes/stubs';
import { userRoutes } from './routes/users';
import { variableRoutes } from './routes/variables';
import { workflowRoutes } from './routes/workflows';
import { webhookRoutes } from '../webhooks/routes';

export { HttpError } from './errors';

export interface AppEnv {
	Bindings: Env;
	Variables: {
		/** Set by the auth middleware when the request carries a valid session. */
		user?: UserRow;
		usedMfa?: boolean;
	};
}

export type AppContext = Context<AppEnv>;

/** Most /rest responses are wrapped as `{ data }` (cli/src/response-helper.ts). */
export const ok = (c: AppContext, data: unknown, status: ContentfulStatusCode = 200) =>
	c.json({ data }, status);

export function baseUrlOf(c: AppContext): string {
	return (c.env.N8N_EDITOR_BASE_URL ?? new URL(c.req.url).origin).replace(/\/$/, '');
}

export function runContextOf(c: AppContext): RunContext {
	return { env: c.env, ctx: c.executionCtx, baseUrl: baseUrlOf(c) };
}

export function createApp() {
	const app = new Hono<AppEnv>();

	app.onError((error, c) => {
		if (error instanceof HttpError) {
			return c.json({ code: error.status, message: error.message, hint: error.hint }, error.status);
		}
		console.error(error);
		return c.json(
			{ code: 500, message: error instanceof Error ? error.message : String(error) },
			500,
		);
	});

	app.notFound((c) => c.json({ code: 404, message: 'Not Found' }, 404));

	app.get('/healthz', (c) => c.json({ status: 'ok' }));

	const rest = new Hono<AppEnv>();
	rest.use('*', authMiddleware);
	rest.route('/', authRoutes);
	rest.route('/', settingsRoutes);
	rest.route('/', projectRoutes);
	rest.route('/', userRoutes);
	rest.route('/', workflowRoutes);
	rest.route('/', credentialRoutes);
	rest.route('/', executionRoutes);
	rest.route('/', annotationTagRoutes);
	rest.route('/', binaryDataRoutes);
	rest.route('/', oauthRoutes);
	rest.route('/', dynamicParameterRoutes);
	rest.route('/', nodeTypeRoutes);
	rest.route('/', variableRoutes);
	rest.route('/', pushRoutes);
	rest.route('/', stubRoutes);
	app.route('/rest', signedBinaryDataRoutes);
	app.route('/rest', rest);
	app.route('/', webhookRoutes);

	return app;
}
