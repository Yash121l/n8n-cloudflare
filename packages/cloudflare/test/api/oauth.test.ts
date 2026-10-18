import { createHash, createHmac, createDecipheriv } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ENCRYPTION_KEY, Instance, dataOf, recordOf, startInstance } from './harness';
import type { Session } from './harness';
import { insertMember, queryDb } from './sql';

/** CryptoJS passphrase format of stock n8n: "Salted__" + salt + AES-256-CBC with an MD5 EVP_BytesToKey key. */
function decryptCredential(data: string): Record<string, unknown> {
	const raw = Buffer.from(data, 'base64');
	expect(raw.subarray(0, 8).toString()).toBe('Salted__');
	const salt = raw.subarray(8, 16);
	let derived = Buffer.alloc(0);
	let block = Buffer.alloc(0);
	while (derived.length < 48) {
		block = createHash('md5')
			.update(Buffer.concat([block, Buffer.from(ENCRYPTION_KEY), salt]))
			.digest();
		derived = Buffer.concat([derived, block]);
	}
	const decipher = createDecipheriv(
		'aes-256-cbc',
		derived.subarray(0, 32),
		derived.subarray(32, 48),
	);
	const json = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString();
	return recordOf(JSON.parse(json));
}

const storedData = (instance: Instance, id: string) => {
	const [row] = queryDb(instance, `SELECT data FROM credentials_entity WHERE id = '${id}'`);
	return decryptCredential(String(row.data));
};

const percentEncode = (value: string) =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);

/** Independent check of an RFC 5849 HMAC-SHA1 signature. */
function oauth1SignatureValid(
	req: IncomingMessage,
	url: URL,
	body: string,
	consumerSecret: string,
	tokenSecret: string,
): boolean {
	const header = String(req.headers.authorization);
	const params = Object.fromEntries(
		[...header.slice('OAuth '.length).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [
			m[1],
			decodeURIComponent(m[2]),
		]),
	);
	const { oauth_signature: signature, ...signed } = params;
	const all = [
		...url.searchParams.entries(),
		...new URLSearchParams(body).entries(),
		...Object.entries(signed),
	]
		.map(([k, v]) => [percentEncode(k), percentEncode(v)])
		.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
		.map(([k, v]) => `${k}=${v}`)
		.join('&');
	const base = `${req.method}&${percentEncode(`${url.origin}${url.pathname}`)}&${percentEncode(all)}`;
	const expected = createHmac(
		'sha1',
		`${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`,
	)
		.update(base)
		.digest('base64');
	return expected === signature;
}

interface Provider {
	origin: string;
	tokenRequests: Array<{ headers: IncomingMessage['headers']; form: URLSearchParams }>;
	failToken: boolean;
	oauth1: { requestTokenCallback: string; accessTokenOk: boolean };
}

async function body(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString();
}

describe('oauth credential connect', () => {
	let instance: Instance;
	let owner: Session;
	let server: Server;
	const provider: Provider = {
		origin: '',
		tokenRequests: [],
		failToken: false,
		oauth1: { requestTokenCallback: '', accessTokenOk: false },
	};

	beforeAll(async () => {
		server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const url = new URL(req.url ?? '/', provider.origin);
				const text = await body(req);
				if (url.pathname === '/token') {
					provider.tokenRequests.push({ headers: req.headers, form: new URLSearchParams(text) });
					if (provider.failToken) {
						res
							.writeHead(400, { 'content-type': 'application/json' })
							.end(JSON.stringify({ error: 'invalid_grant' }));
						return;
					}
					res
						.writeHead(200, { 'content-type': 'application/json' })
						.end(
							JSON.stringify({
								access_token: 'at-1',
								refresh_token: 'rt-1',
								token_type: 'Bearer',
								expires_in: 3600,
							}),
						);
				} else if (url.pathname === '/request_token') {
					if (!oauth1SignatureValid(req, url, text, 'csecret', ''))
						return void res.writeHead(401).end('bad signature');
					provider.oauth1.requestTokenCallback = decodeURIComponent(
						/oauth_callback="([^"]*)"/.exec(String(req.headers.authorization))?.[1] ?? '',
					);
					res
						.writeHead(200)
						.end(
							'oauth_token=req-token&oauth_token_secret=req-secret&oauth_callback_confirmed=true',
						);
				} else if (url.pathname === '/access_token') {
					provider.oauth1.accessTokenOk = oauth1SignatureValid(
						req,
						url,
						text,
						'csecret',
						'req-secret',
					);
					if (
						!provider.oauth1.accessTokenOk ||
						new URLSearchParams(text).get('oauth_verifier') !== 'verifier-1'
					) {
						return void res.writeHead(401).end('bad signature');
					}
					res.writeHead(200).end('oauth_token=access-token&oauth_token_secret=access-secret');
				} else {
					res.writeHead(404).end();
				}
			})();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		provider.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		instance = await startInstance();
		owner = await instance.ownerSession();
	}, 120_000);

	afterAll(async () => {
		server?.close();
		await instance?.dispose();
	});

	async function oauth2Credential(extra: Record<string, unknown> = {}): Promise<string> {
		const res = await owner.post('/rest/credentials', {
			name: 'Fake OAuth2',
			type: 'oAuth2Api',
			data: {
				grantType: 'authorizationCode',
				authUrl: `${provider.origin}/authorize`,
				accessTokenUrl: `${provider.origin}/token`,
				clientId: 'client-1',
				clientSecret: 'secret-1',
				scope: 'read write',
				authQueryParameters: 'access_type=offline',
				authentication: 'header',
				...extra,
			},
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return String(recordOf(dataOf(res)).id);
	}

	const startAuth = async (session: Session, id: string, version = 2) => {
		const res = await session.get(`/rest/oauth${version}-credential/auth?id=${id}`);
		return { res, url: typeof dataOf(res) === 'string' ? new URL(String(dataOf(res))) : undefined };
	};

	const callback = (session: Session, version: number, params: Record<string, string>) =>
		session.get(`/rest/oauth${version}-credential/callback?${new URLSearchParams(params)}`);

	it('returns the authorization url and stores the token after the callback', async () => {
		const id = await oauth2Credential();
		const { res, url } = await startAuth(owner, id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(url?.origin).toBe(provider.origin);
		expect(url?.pathname).toBe('/authorize');
		expect(Object.fromEntries(url!.searchParams)).toMatchObject({
			client_id: 'client-1',
			response_type: 'code',
			scope: 'read write',
			access_type: 'offline',
			redirect_uri: `${instance.origin}/rest/oauth2-credential/callback`,
		});
		const state = url!.searchParams.get('state')!;

		const done = await callback(owner, 2, { code: 'code-1', state });
		expect(done.status).toBe(200);
		expect(String(done.body)).toContain('Connection successful');
		expect(done.headers.get('content-security-policy')).toContain('script-src');

		const request = provider.tokenRequests.at(-1)!;
		expect(request.form.get('code')).toBe('code-1');
		expect(request.form.get('grant_type')).toBe('authorization_code');
		expect(request.form.get('redirect_uri')).toBe(
			`${instance.origin}/rest/oauth2-credential/callback`,
		);
		expect(request.headers.authorization).toBe(
			`Basic ${Buffer.from('client-1:secret-1').toString('base64')}`,
		);

		const stored = storedData(instance, id);
		expect(stored.clientSecret).toBe('secret-1');
		expect(stored.oauthTokenData).toMatchObject({
			access_token: 'at-1',
			refresh_token: 'rt-1',
			token_type: 'Bearer',
			expires_in: 3600,
		});
		expect(Number(recordOf(stored.oauthTokenData).n8n_expires_at)).toBeGreaterThan(Date.now());

		const shown = recordOf(dataOf(await owner.get(`/rest/credentials/${id}?includeData=true`)));
		expect(recordOf(shown.data).oauthTokenData).toBe(true);
	});

	it('refuses a state that is used twice or by another user', async () => {
		const id = await oauth2Credential();
		const intruder = await instance.memberSession(await insertMember(instance, 'intruder'));
		const { url } = await startAuth(owner, id);
		const state = url!.searchParams.get('state')!;

		const stolen = await callback(intruder, 2, { code: 'code-x', state });
		expect(String(stolen.body)).toContain('Error: Unauthorized');
		expect(await callback(instance.session(), 2, { code: 'code-x', state })).toMatchObject({
			status: 200,
		});
		expect(provider.tokenRequests.filter((r) => r.form.get('code') === 'code-x')).toHaveLength(0);

		const first = await callback(owner, 2, { code: 'code-2', state });
		expect(String(first.body)).toContain('Connection successful');
		const replay = await callback(owner, 2, { code: 'code-3', state });
		expect(String(replay.body)).toContain('The OAuth callback state is invalid!');
		expect(provider.tokenRequests.filter((r) => r.form.get('code') === 'code-3')).toHaveLength(0);
	});

	it('does not start a flow for a credential the user cannot change', async () => {
		const id = await oauth2Credential();
		const outsider = await instance.memberSession(await insertMember(instance, 'outsider'));
		expect((await startAuth(outsider, id)).res.status).toBe(404);
		expect((await owner.get('/rest/oauth2-credential/auth')).status).toBe(400);
		expect((await instance.session().get(`/rest/oauth2-credential/auth?id=${id}`)).status).toBe(
			401,
		);
	});

	it('sends the PKCE challenge and the matching verifier', async () => {
		const id = await oauth2Credential({ grantType: 'pkce' });
		const { url } = await startAuth(owner, id);
		const challenge = url!.searchParams.get('code_challenge')!;
		expect(url!.searchParams.get('code_challenge_method')).toBe('S256');

		await callback(owner, 2, { code: 'code-pkce', state: url!.searchParams.get('state')! });
		const verifier = provider.tokenRequests.at(-1)!.form.get('code_verifier')!;
		expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
	});

	it('sends client credentials in the body when the credential says so', async () => {
		const id = await oauth2Credential({ authentication: 'body' });
		const { url } = await startAuth(owner, id);
		await callback(owner, 2, { code: 'code-body', state: url!.searchParams.get('state')! });
		const request = provider.tokenRequests.at(-1)!;
		expect(request.form.get('client_id')).toBe('client-1');
		expect(request.form.get('client_secret')).toBe('secret-1');
		expect(request.headers.authorization).toBeUndefined();
	});

	it('shows the error page when the token server refuses the code', async () => {
		const id = await oauth2Credential();
		const { url } = await startAuth(owner, id);
		provider.failToken = true;
		try {
			const res = await callback(owner, 2, { code: 'bad', state: url!.searchParams.get('state')! });
			expect(String(res.body)).toContain('Error:');
			expect(String(res.body)).toContain('invalid_grant');
			expect(String(res.body)).toContain('BroadcastChannel');
		} finally {
			provider.failToken = false;
		}
		expect(storedData(instance, id).oauthTokenData).toBeUndefined();
	});

	it('shows an error page when the callback has no code', async () => {
		const res = await callback(owner, 2, { state: 'abc' });
		expect(String(res.body)).toContain('Insufficient parameters for OAuth2 callback.');
	});

	it('connects an OAuth1 credential with signed requests', async () => {
		const created = await owner.post('/rest/credentials', {
			name: 'Fake OAuth1',
			type: 'oAuth1Api',
			data: {
				consumerKey: 'ckey',
				consumerSecret: 'csecret',
				requestTokenUrl: `${provider.origin}/request_token`,
				authUrl: `${provider.origin}/authorize`,
				accessTokenUrl: `${provider.origin}/access_token`,
				signatureMethod: 'HMAC-SHA1',
			},
		});
		expect(created.status, JSON.stringify(created.body)).toBe(200);
		const id = String(recordOf(dataOf(created)).id);

		const { res, url } = await startAuth(owner, id, 1);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(url?.pathname).toBe('/authorize');
		expect(url?.searchParams.get('oauth_token')).toBe('req-token');
		const redirect = new URL(provider.oauth1.requestTokenCallback);
		expect(redirect.origin + redirect.pathname).toBe(
			`${instance.origin}/rest/oauth1-credential/callback`,
		);

		const done = await callback(owner, 1, {
			state: redirect.searchParams.get('state')!,
			oauth_token: 'req-token',
			oauth_verifier: 'verifier-1',
		});
		expect(String(done.body)).toContain('Connection successful');
		expect(provider.oauth1.accessTokenOk).toBe(true);
		expect(storedData(instance, id).oauthTokenData).toEqual({
			oauth_token: 'access-token',
			oauth_token_secret: 'access-secret',
		});
	});
});
