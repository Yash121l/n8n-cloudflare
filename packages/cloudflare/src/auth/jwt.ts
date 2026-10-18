/** HS256 session JWTs, signed with Web Crypto and compatible with stock n8n tokens. */

export const AUTH_COOKIE_NAME = 'n8n-auth';
export const SESSION_AUDIENCE = 'n8n:session';
export const INVITE_AUDIENCE = 'n8n:invite';
export const PASSWORD_RESET_AUDIENCE = 'n8n-password-reset';
export const SESSION_DURATION_SECONDS = 168 * 60 * 60;

export interface SessionPayload {
	id: string;
	hash: string;
	browserId?: string;
	usedMfa?: boolean;
}

export interface IssuedSession extends SessionPayload {
	exp: number;
}

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string) => {
	const padded = value
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Base64(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
	return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** Stock n8n derives the signing secret from every second character of the encryption key. */
export async function deriveJwtSecret(encryptionKey: string): Promise<string> {
	let baseKey = '';
	for (let i = 0; i < encryptionKey.length; i += 2) baseKey += encryptionKey[i];
	return await sha256Hex(baseKey);
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
	const cacheKey = `${usage}:${secret}`;
	let key = keyCache.get(cacheKey);
	if (!key) {
		key = crypto.subtle.importKey(
			'raw',
			encoder.encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			[usage],
		);
		keyCache.set(cacheKey, key);
	}
	return key;
}

/** Signs an HS256 token bound to `audience`, like `JwtService.sign` in stock n8n. */
export async function signToken(
	secret: string,
	payload: object,
	audience: string,
	expiresInSeconds: number,
): Promise<string> {
	const iat = Math.floor(Date.now() / 1000);
	const header = toBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
	const body = toBase64Url(
		encoder.encode(JSON.stringify({ ...payload, iat, exp: iat + expiresInSeconds, aud: audience })),
	);
	const signature = await crypto.subtle.sign(
		'HMAC',
		await importKey(secret, 'sign'),
		encoder.encode(`${header}.${body}`),
	);
	return `${header}.${body}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function signSession(
	secret: string,
	payload: SessionPayload,
	expiresInSeconds = SESSION_DURATION_SECONDS,
): Promise<string> {
	// Two logins in the same second would otherwise share a token, and a logout would revoke both.
	return await signToken(
		secret,
		{ ...payload, jti: crypto.randomUUID() },
		SESSION_AUDIENCE,
		expiresInSeconds,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIssuedSession(payload: unknown): payload is IssuedSession {
	if (!isRecord(payload)) return false;
	const { id, hash, exp, browserId, usedMfa } = payload;
	return (
		typeof id === 'string' &&
		id.length > 0 &&
		typeof hash === 'string' &&
		typeof exp === 'number' &&
		Number.isFinite(exp) &&
		(browserId === undefined || typeof browserId === 'string') &&
		(usedMfa === undefined || typeof usedMfa === 'boolean')
	);
}

/** Returns the payload of a valid, unexpired token for `audience`, or null. */
export async function verifyToken(
	secret: string,
	token: string,
	audience: string,
): Promise<Record<string, unknown> | null> {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [header, body, signature] = parts;
	try {
		const headerJson: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(header)));
		if (!isRecord(headerJson) || headerJson.alg !== 'HS256') return null;
		const valid = await crypto.subtle.verify(
			'HMAC',
			await importKey(secret, 'verify'),
			fromBase64Url(signature),
			encoder.encode(`${header}.${body}`),
		);
		if (!valid) return null;
		const payload: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
		if (!isRecord(payload) || payload.aud !== audience) return null;
		if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
		return payload;
	} catch {
		return null;
	}
}

/** Returns the payload of a valid, unexpired session token, or null. */
export async function verifySession(secret: string, token: string): Promise<IssuedSession | null> {
	const payload = await verifyToken(secret, token, SESSION_AUDIENCE);
	return isIssuedSession(payload) ? payload : null;
}
