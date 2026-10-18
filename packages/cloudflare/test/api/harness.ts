import { cpSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { unstable_startWorker as startWorker } from 'wrangler';
import { inject } from 'vitest';

type StartedWorker = Awaited<ReturnType<typeof startWorker>>;

export const ENCRYPTION_KEY = 'test-encryption-key-0123456789abcdef';

export const OWNER = {
	email: 'owner@example.com',
	firstName: 'Ada',
	lastName: 'Lovelace',
	password: 'Password123',
};

export interface Json {
	status: number;
	headers: Headers;
	body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads `body.data` from a `{ data }` response. */
export function dataOf(response: Json): unknown {
	if (!isRecord(response.body)) throw new Error(`no JSON object body, status ${response.status}`);
	return response.body.data;
}

export function recordOf(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`expected an object, got ${JSON.stringify(value)}`);
	return value;
}

export function arrayOf(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error(`expected an array, got ${JSON.stringify(value)}`);
	return value;
}

/** A client that keeps cookies between requests, like the browser the editor runs in. */
export class Session {
	private cookie = '';

	constructor(private readonly instance: Instance) {}

	get hasCookie() {
		return this.cookie !== '';
	}

	/** For clients that cannot go through `request`, like WebSockets. */
	get cookieHeader() {
		return this.cookie;
	}

	async request(
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string> = {},
	): Promise<Json> {
		const response = await this.instance.worker.fetch(`${this.instance.origin}${path}`, {
			method,
			headers: {
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
				...(this.cookie ? { cookie: this.cookie } : {}),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: 'manual',
		});
		const setCookie = response.headers.get('set-cookie');
		if (setCookie) {
			const pair = setCookie.split(';')[0];
			this.cookie = pair.endsWith('=') ? '' : pair;
		}
		const text = await response.text();
		let parsed: unknown = text;
		try {
			parsed = text === '' ? null : JSON.parse(text);
		} catch {
			// Non-JSON body, keep the raw text.
		}
		return { status: response.status, headers: response.headers, body: parsed };
	}

	get = (path: string, headers?: Record<string, string>) =>
		this.request('GET', path, undefined, headers);
	post = (path: string, body?: unknown) => this.request('POST', path, body ?? {});
	patch = (path: string, body: unknown) => this.request('PATCH', path, body);
	put = (path: string, body: unknown) => this.request('PUT', path, body);
	delete = (path: string, body?: unknown) => this.request('DELETE', path, body);

	async setupOwner(): Promise<Json> {
		return await this.post('/rest/owner/setup', OWNER);
	}
}

/** One built worker with its own empty local D1 and R2. */
export class Instance {
	constructor(
		readonly worker: StartedWorker,
		readonly origin: string,
		/** Directory with the local D1 and R2 state of this instance. */
		readonly persist: string,
	) {}

	session(): Session {
		return new Session(this);
	}

	private ownerExists = false;

	/** A logged-in owner session. The first call sets the owner up, later calls log in. */
	async ownerSession(): Promise<Session> {
		const session = this.session();
		const response = this.ownerExists
			? await session.post('/rest/login', {
					emailOrLdapLoginId: OWNER.email,
					password: OWNER.password,
				})
			: await session.setupOwner();
		if (response.status !== 200)
			throw new Error(`owner session failed: ${JSON.stringify(response.body)}`);
		this.ownerExists = true;
		return session;
	}

	/** A session logged in as a user from `insertMember`. */
	async memberSession(member: { email: string; password: string }): Promise<Session> {
		const session = this.session();
		const response = await session.post('/rest/login', {
			emailOrLdapLoginId: member.email,
			password: member.password,
		});
		if (response.status !== 200)
			throw new Error(`member login failed: ${JSON.stringify(response.body)}`);
		return session;
	}

	async dispose() {
		await this.worker.dispose();
	}
}

/** The login rate limit is off unless a test asks for it, because most tests log in many times as one user. */
export async function startInstance(options: { rateLimit?: boolean } = {}): Promise<Instance> {
	const harnessDir = inject('harnessDir');
	const persist = mkdtempSync(join(harnessDir, 'persist-'));
	cpSync(join(harnessDir, 'snapshot'), persist, { recursive: true });
	process.env.WRANGLER_LOG_PATH ??= join(harnessDir, 'logs');

	const worker = await startWorker({
		config: join(harnessDir, 'wrangler.jsonc'),
		bindings: {
			N8N_ENCRYPTION_KEY: { type: 'plain_text', value: ENCRYPTION_KEY },
			N8N_RATE_LIMIT_DISABLED: { type: 'plain_text', value: options.rateLimit ? 'false' : 'true' },
		},
		dev: { persist, server: { port: 0 }, inspector: false, logLevel: 'error' },
	});
	await worker.ready;
	const url = await worker.url;
	return new Instance(worker, url.origin, persist);
}
