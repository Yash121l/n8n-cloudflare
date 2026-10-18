import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';

import { HttpError } from '../api/errors';
import type { AppContext, AppEnv } from '../api/app';
import { findUserById, isTokenInvalidated } from '../db/users';
import type { UserRow } from '../db/types';
import type { Env } from '../env';
import {
	AUTH_COOKIE_NAME,
	SESSION_DURATION_SECONDS,
	deriveJwtSecret,
	sha256Base64,
	signSession,
	verifySession,
} from './jwt';
import { createJwtHash } from './password';

const REFRESH_WINDOW_SECONDS = SESSION_DURATION_SECONDS * 0.25;

const secrets = new Map<string, Promise<string>>();

export function jwtSecretOf(env: Pick<Env, 'N8N_ENCRYPTION_KEY'>): Promise<string> {
	let secret = secrets.get(env.N8N_ENCRYPTION_KEY);
	if (!secret) {
		secret = deriveJwtSecret(env.N8N_ENCRYPTION_KEY);
		secrets.set(env.N8N_ENCRYPTION_KEY, secret);
	}
	return secret;
}

/** Routes stock n8n serves without a session. Entries are `METHOD path`, `*` matches one segment. */
const PUBLIC_ROUTES: Array<[string, RegExp]> = [
	['GET', /^\/rest\/settings$/],
	['POST', /^\/rest\/login$/],
	['POST', /^\/rest\/owner\/setup$/],
	['GET', /^\/rest\/resolve-signup-token$/],
	['POST', /^\/rest\/invitations\/accept$/],
	['POST', /^\/rest\/forgot-password$/],
	['GET', /^\/rest\/resolve-password-token$/],
	['POST', /^\/rest\/change-password$/],
	['GET', /^\/rest\/oauth[12]-credential\/callback$/],
	['GET', /^\/rest\/options\/timezones$/],
];

const BROWSER_ID_EXEMPT_GET: RegExp[] = [
	/^\/rest\/push$/,
	/^\/rest\/binary-data(\/|$)/,
	/^\/rest\/oauth[12]-credential\/callback$/,
	/^\/rest\/credentials\/[^/]+\/authorize$/,
];

const isPublic = (method: string, path: string) =>
	PUBLIC_ROUTES.some(([m, re]) => m === method && re.test(path));

export function isSecureRequest(c: AppContext): boolean {
	return new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
}

export async function issueAuthCookie(
	c: AppContext,
	user: UserRow,
	usedMfa = false,
): Promise<void> {
	const browserId = c.req.header('browser-id');
	const token = await signSession(await jwtSecretOf(c.env), {
		id: user.id,
		hash: await createJwtHash(user),
		browserId: browserId ? await sha256Base64(browserId) : undefined,
		usedMfa,
	});
	setCookie(c, AUTH_COOKIE_NAME, token, {
		maxAge: SESSION_DURATION_SECONDS,
		httpOnly: true,
		sameSite: 'Lax',
		secure: isSecureRequest(c),
		path: '/',
	});
}

export function clearAuthCookie(c: AppContext): void {
	deleteCookie(c, AUTH_COOKIE_NAME, { path: '/' });
}

/** Returns the user or throws 401. Use in handlers behind the auth middleware. */
export function requireUser(c: AppContext): UserRow {
	const user = c.get('user');
	if (!user) throw new HttpError(401, 'Unauthorized');
	return user;
}

async function resolveSession(c: AppContext): Promise<{ user: UserRow; usedMfa: boolean } | null> {
	const token = getCookie(c, AUTH_COOKIE_NAME);
	if (!token) return null;

	const payload = await verifySession(await jwtSecretOf(c.env), token);
	if (!payload) {
		clearAuthCookie(c);
		return null;
	}
	const [invalidated, user] = await Promise.all([
		isTokenInvalidated(c.env.DB, token),
		findUserById(c.env.DB, payload.id),
	]);
	if (invalidated) {
		clearAuthCookie(c);
		return null;
	}
	if (!user || user.disabled || payload.hash !== (await createJwtHash(user))) {
		clearAuthCookie(c);
		return null;
	}

	const path = new URL(c.req.url).pathname;
	const skipBrowserId = c.req.method === 'GET' && BROWSER_ID_EXEMPT_GET.some((re) => re.test(path));
	if (!skipBrowserId && payload.browserId) {
		const browserId = c.req.header('browser-id');
		if (!browserId || payload.browserId !== (await sha256Base64(browserId))) {
			clearAuthCookie(c);
			return null;
		}
	}

	const usedMfa = payload.usedMfa ?? false;
	if (payload.exp - Date.now() / 1000 < REFRESH_WINDOW_SECONDS) {
		await issueAuthCookie(c, user, usedMfa);
	}
	return { user, usedMfa };
}

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
	const session = await resolveSession(c);
	if (session) {
		c.set('user', session.user);
		c.set('usedMfa', session.usedMfa);
		return await next();
	}
	if (isPublic(c.req.method, new URL(c.req.url).pathname)) return await next();
	return c.json({ status: 'error', message: 'Unauthorized' }, 401);
};
