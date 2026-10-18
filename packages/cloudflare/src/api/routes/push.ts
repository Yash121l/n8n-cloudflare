import { Hono } from 'hono';

import { requireUser } from '../../auth/middleware';
import type { AppEnv } from '../app';
import { badRequest } from '../errors';
import { isValidWebSocketOrigin } from '../origin-validator';

export const pushRoutes = new Hono<AppEnv>();

pushRoutes.get('/push', async (c) => {
	const user = requireUser(c);
	const pushRef = c.req.query('pushRef');
	if (!pushRef) throw badRequest('The query parameter "pushRef" is missing!');
	if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
		throw badRequest(
			'Request is not a PushRequest',
			'Server-sent events are not supported, use pushBackend "websocket"',
		);
	}
	if (!isValidWebSocketOrigin((name) => c.req.header(name), new URL(c.req.url).host))
		throw badRequest('Invalid origin!');

	const url = new URL(c.req.url);
	url.search = '';
	url.searchParams.set('pushRef', pushRef);
	url.searchParams.set('userId', user.id);

	const hub = c.env.PUSH.get(c.env.PUSH.idFromName('global'));
	return await hub.fetch(new Request(url, c.req.raw));
});
