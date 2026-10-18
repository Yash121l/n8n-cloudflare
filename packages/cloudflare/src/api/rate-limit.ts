import type { Env } from '../env';
import { HttpError } from './errors';
import type { AppContext } from './app';

/**
 * The Workers rate limit binding only counts in 10 or 60 second windows, so the stock limits map like this:
 * - login per IP: stock 1000 per 5 minutes, here 200 per 60 seconds (same average rate)
 * - login per email: stock 5 per minute, here 5 per 60 seconds
 * - password change per user: stock 5 per 5 minutes, here 5 per 60 seconds
 * - invite and password reset tokens per IP: stock limits these per IP too, here they share the login IP limiter
 * Windows are fixed, not sliding, and counted per Cloudflare location.
 */
type Limiter = 'LOGIN_IP_LIMITER' | 'LOGIN_EMAIL_LIMITER' | 'PASSWORD_USER_LIMITER';

/** Stock only limits in production. `N8N_RATE_LIMIT_DISABLED=true` is the same switch for tests and local use. */
async function isAllowed(env: Env, limiter: Limiter, key: string): Promise<boolean> {
	if (env.N8N_RATE_LIMIT_DISABLED === 'true') return true;
	const { success } = await env[limiter].limit({ key });
	return success;
}

export async function limitLoginByIp(c: AppContext): Promise<void> {
	const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
	if (!(await isAllowed(c.env, 'LOGIN_IP_LIMITER', ip)))
		throw new HttpError(429, 'Too many requests');
}

/** For the public routes that take an invite or password reset token. Keyed apart from logins. */
export async function limitTokenByIp(c: AppContext): Promise<void> {
	const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
	if (!(await isAllowed(c.env, 'LOGIN_IP_LIMITER', `token:${ip}`)))
		throw new HttpError(429, 'Too many requests');
}

/** Counts every attempt, including right ones, and ignores the letter case of the email like the login lookup does. */
export async function limitLoginByEmail(c: AppContext, email: string): Promise<void> {
	if (!(await isAllowed(c.env, 'LOGIN_EMAIL_LIMITER', email.trim().toLowerCase()))) {
		throw new HttpError(429, 'Too many requests, please try again later.');
	}
}

export async function limitPasswordChange(c: AppContext, userId: string): Promise<void> {
	if (!(await isAllowed(c.env, 'PASSWORD_USER_LIMITER', userId))) {
		throw new HttpError(429, 'Too many requests, please try again later.');
	}
}
