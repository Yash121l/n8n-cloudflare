import { Readable } from 'node:stream';
import type { IWorkflowExecuteAdditionalData } from 'n8n-workflow';

export interface UploadedFile {
	filepath: string;
	originalFilename: string;
	newFilename: string;
	mimetype: string;
	size: number;
}

export class WebhookHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function addValue(target: Record<string, unknown>, key: string, value: unknown) {
	if (!Object.hasOwn(target, key)) target[key] = value;
	else target[key] = Array.isArray(target[key]) ? [...target[key], value] : [target[key], value];
}

export async function adaptRequest(
	request: Request,
	params: Record<string, string> = {},
	preserveCookies = false,
) {
	const reader = request.body?.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	if (reader) {
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.byteLength;
				if (size > 16 * 1024 * 1024) {
					await reader.cancel();
					throw new WebhookHttpError(413, 'Webhook payload is too large');
				}
				chunks.push(Buffer.from(chunk.value));
			}
		} finally {
			reader.releaseLock();
		}
	}
	const rawBody = Buffer.concat(chunks, size);
	const url = new URL(request.url);
	const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
	const query: Record<string, unknown> = {};
	for (const [key, value] of url.searchParams) addValue(query, key, value);
	const files = new Map<string, Buffer>();
	let body: unknown = {};
	if (rawBody.length) {
		if (contentType === 'application/json' || contentType?.endsWith('+json')) {
			try {
				body = JSON.parse(rawBody.toString());
			} catch {
				throw new WebhookHttpError(400, 'Invalid JSON in request body');
			}
		} else if (contentType === 'application/x-www-form-urlencoded') {
			const fields: Record<string, unknown> = {};
			for (const [key, value] of new URLSearchParams(rawBody.toString()))
				addValue(fields, key, value);
			body = fields;
		} else if (contentType === 'multipart/form-data') {
			const form = await new Response(rawBody, { headers: request.headers }).formData();
			const data: Record<string, unknown> = {};
			const uploaded: Record<string, unknown> = {};
			for (const [key, value] of form) {
				if (typeof value === 'string') addValue(data, key, value);
				else {
					const filepath = `/tmp/n8n-upload-${crypto.randomUUID()}`;
					files.set(filepath, Buffer.from(await value.arrayBuffer()));
					addValue(uploaded, key, {
						filepath,
						originalFilename: value.name,
						newFilename: value.name,
						mimetype: value.type,
						size: value.size,
					} satisfies UploadedFile);
				}
			}
			body = { data, files: uploaded };
		} else if (contentType?.startsWith('text/')) body = rawBody.toString();
		else body = undefined;
	}
	const headers = Object.fromEntries(request.headers);
	if (!preserveCookies && headers.cookie) {
		const excluded = new Set([
			'n8n-auth',
			'n8n-browserId',
			'n8n-oauth-session',
			'n8n-oauth-binding',
			'n8n-oidc-id-token',
			'n8n-oidc-state',
			'n8n-oidc-nonce',
			'n8n-form-oauth',
			'n8n-chat-oauth',
			'n8n-chat-oauth-refresh',
		]);
		headers.cookie = headers.cookie
			.split(';')
			.map((cookie) => cookie.trim())
			.filter((cookie) => {
				const name = cookie.split('=')[0];
				return (
					!excluded.has(name) &&
					!name.startsWith('n8n-form-auth-') &&
					!name.startsWith('n8n-oauth-session-')
				);
			})
			.join('; ');
	}
	const stream = Readable.from([rawBody]);
	const adapted = Object.assign(stream, {
		headers,
		query,
		params,
		body,
		rawBody,
		contentType,
		method: request.method,
		url: url.pathname + url.search,
		originalUrl: url.pathname + url.search,
		protocol: url.protocol.slice(0, -1),
		hostname: url.hostname,
		path: url.pathname,
		ip: request.headers.get('cf-connecting-ip') ?? '127.0.0.1',
		ips: [] as string[],
		cookies: Object.fromEntries(
			(headers.cookie ?? '')
				.split(';')
				.filter(Boolean)
				.map((cookie) => {
					const index = cookie.indexOf('=');
					return [cookie.slice(0, index).trim(), cookie.slice(index + 1)];
				}),
		),
		get: (name: string) => headers[name.toLowerCase()],
		header: (name: string) => headers[name.toLowerCase()],
		is: (value: string) => contentType === value,
		readRawBody: async () => rawBody,
		// A streaming Chat Trigger tunes the socket. The runtime manages the connection here.
		socket: { setTimeout() {}, setNoDelay() {}, setKeepAlive() {} },
	});
	return {
		request: adapted as unknown as NonNullable<IWorkflowExecuteAdditionalData['httpRequest']>,
		files,
		rawBody,
		contentType,
	};
}
