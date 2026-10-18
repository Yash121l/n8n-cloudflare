import { Hono } from 'hono';

import type { AppContext, AppEnv } from '../../app';
import { ok } from '../../app';
import { badRequest } from '../../errors';

/** Features that are off here. Each answers the way stock n8n answers with the feature off. */
export const disabledStubs = new Hono<AppEnv>();

/** Body and status of the stock `@Licensed` guard (cli/src/controller.registry.ts). */
export const unlicensed = (c: AppContext) =>
	c.json({ status: 'error', message: 'Plan lacks license for this feature' }, 403);

const reject = (message: string) => () => {
	throw badRequest(message);
};

// Licensed enterprise features. The editor never calls these because `enterprise.*` is all false.
for (const prefix of [
	'/ldap',
	'/sso/saml',
	'/sso/oidc',
	'/sso/provisioning',
	'/role-mapping-rule',
	'/source-control',
	'/external-secrets',
	'/secret-providers',
	'/eventbus',
	'/settings/security',
	'/credential-resolvers',
	'/workflow-review-requests',
]) {
	disabledStubs.all(prefix, unlicensed);
	disabledStubs.all(`${prefix}/*`, unlicensed);
}
disabledStubs.all('/projects/:projectId/pool-settings', unlicensed);

// Evaluations: `settings.evaluation` is off, so the lists stay empty.
disabledStubs.get('/workflows/:workflowId/test-runs', (c) => ok(c, []));
disabledStubs.get('/workflows/:workflowId/evaluation-configs', (c) => ok(c, []));
disabledStubs.get('/workflows/:workflowId/eval-versions', (c) => ok(c, []));

// Community nodes cannot be installed at runtime on Workers.
disabledStubs.get('/community-packages', (c) => ok(c, []));
disabledStubs.on(
	['POST', 'PATCH', 'DELETE'],
	'/community-packages',
	reject('Community packages cannot be installed on this instance'),
);
disabledStubs.get('/community-node-types', (c) => ok(c, []));
disabledStubs.get('/community-node-types/:name', (c) => ok(c, null));

// Public API keys are off (`publicApi.enabled` is false).
disabledStubs.get('/api-keys', (c) => ok(c, []));
disabledStubs.get('/api-keys/scopes', (c) => ok(c, []));
disabledStubs.on(
	['POST', 'PATCH', 'DELETE'],
	['/api-keys', '/api-keys/*'],
	reject('API keys are not available on this instance'),
);

// MFA needs TOTP secrets and recovery codes; `mfa.enabled` is false.
disabledStubs.on(
	['GET', 'POST'],
	['/mfa/qr', '/mfa/can-enable', '/mfa/enable', '/mfa/verify', '/mfa/disable', '/mfa/enforce-mfa'],
	reject('MFA is not available on this instance'),
);

disabledStubs.get('/third-party-licenses', (c) =>
	c.text('Third-party licenses file not found', 404),
);
disabledStubs.get('/cta/become-creator', (c) => c.json(false));

// `GET /instance-version-history/*` feeds the publish timeline. No version history is kept.
disabledStubs.get('/instance-version-history/first-adoption', (c) => ok(c, { date: null }));
disabledStubs.get('/instance-version-history/min-version-since', (c) => ok(c, { version: null }));
disabledStubs.get('/instance-version-history/date-since-version', (c) => ok(c, { date: null }));
disabledStubs.get('/instance-version-history/current', (c) =>
	ok(c, { version: null, createdAt: null }),
);

// Email changes need email delivery, which is not set up here.
disabledStubs.on(
	['POST', 'PATCH', 'DELETE'],
	['/change-email', '/confirm-email-change'],
	reject('User management is not available on this instance'),
);
disabledStubs.on(
	['GET', 'POST'],
	['/resolve-change-email-token'],
	reject('User management is not available on this instance'),
);
