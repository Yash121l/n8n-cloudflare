import { Hono } from 'hono';

import { requireUser } from '../../../auth/middleware';
import { parseJson } from '../../../db/types';
import { updateUser } from '../../../db/users';
import type { AppEnv } from '../../app';
import { ok } from '../../app';
import { TIMEZONE_NAMES } from '../../data/timezones';
import { badRequest } from '../../errors';
import { isRecord, readJson } from '../../http';

/** Endpoints the editor calls on boot or on main screens that need a little real logic. */
export const coreStubs = new Hono<AppEnv>();

coreStubs.get('/events/session-started', (c) => ok(c, null));

coreStubs.get('/options/timezones', (c) =>
	ok(c, Object.fromEntries(TIMEZONE_NAMES.map((name) => [name, name.replaceAll('_', ' ')]))),
);

coreStubs.get('/license', async (c) => {
	const row = await c.env.DB.prepare(
		'SELECT COALESCE(SUM(triggerCount), 0) AS n FROM workflow_entity WHERE active = 1',
	).first<{ n: number }>();
	return ok(c, {
		usage: {
			activeWorkflowTriggers: { value: row?.n ?? 0, limit: -1, warningThreshold: 0.8 },
			workflowsHavingEvaluations: { value: 0, limit: -1 },
		},
		license: { planId: '', planName: 'Community' },
	});
});

for (const path of [
	'/license/activate',
	'/license/renew',
	'/license/enterprise/request_trial',
	'/license/enterprise/community-registered',
]) {
	coreStubs.post(path, () => {
		throw badRequest('License management is not available on this instance');
	});
}

function isNpsSurveyState(value: unknown): boolean {
	if (!isRecord(value) || typeof value.lastShownAt !== 'number') return false;
	if (value.responded === true) return true;
	return value.waitingForResponse === true && typeof value.ignoredCount === 'number';
}

coreStubs.patch('/user-settings/nps-survey', async (c) => {
	const user = requireUser(c);
	const body = await readJson(c);
	if (!isNpsSurveyState(body)) throw badRequest('Invalid nps survey state structure');
	const settings = parseJson<Record<string, unknown>>(user.settings, {});
	await updateUser(c.env.DB, user.id, {
		settings: JSON.stringify({ ...settings, npsSurvey: body }),
	});
	return ok(c, null);
});

// Stock answers with the webhook row or null. Dynamic (templated) paths are not probed here.
coreStubs.post('/webhooks/find', async (c) => {
	const { path, method } = await readJson(c);
	if (typeof path !== 'string' || typeof method !== 'string') return ok(c, null);
	const row = await c.env.DB.prepare(
		'SELECT workflowId, webhookPath, method, node FROM webhook_entity WHERE webhookPath = ? AND method = ?',
	)
		.bind(path, method)
		.first();
	return ok(c, row);
});

coreStubs.get('/credential-translation', (c) => ok(c, null));
coreStubs.get('/node-translation-headers', (c) => ok(c, null));
