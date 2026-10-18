import { Writable } from 'node:stream';
import { Container } from '@n8n/di';
import {
	BinaryDataService,
	decodeBufferBody,
	getHtmlSandboxCSP,
	isFormHtmlSandboxingDisabled,
	isWebhookHtmlSandboxingDisabled,
} from 'n8n-core';
import type { IExecuteResponsePromiseData, IWorkflowExecuteAdditionalData } from 'n8n-workflow';

import { renderTemplate } from './templates.js';

/**
 * Port of applySandboxCSP (packages/cli/src/webhooks/webhook-response-headers.ts). The sandbox
 * replaces a CSP that the workflow sets. When an operator disables it, headers stay as they are.
 */
export function applySandboxCSP(headers: Headers, setting: 'webhook' | 'form'): void {
	const disabled =
		setting === 'form' ? isFormHtmlSandboxingDisabled() : isWebhookHtmlSandboxingDisabled();
	if (!disabled) headers.set('content-security-policy', getHtmlSandboxCSP());
}

/** Web stream of a binary source. The Response pulls from it, so the body is never held in memory. */
function toWebStream(source: AsyncIterable<Uint8Array | string>): ReadableStream<Uint8Array> {
	const iterator = source[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await iterator.next();
			if (done) controller.close();
			else controller.enqueue(typeof value === 'string' ? Buffer.from(value) : value);
		},
		async cancel() {
			await iterator.return?.();
		},
	});
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array | string> {
	return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

export class ResponseCollector extends Writable {
	statusCode = 200;
	readonly headers = new Headers();
	readonly locals: Record<string, unknown> = {};
	private readonly chunks: Buffer[] = [];
	private streamed?: ReadableStream<Uint8Array>;
	/** Set while an open stream sends each write to the caller at once. */
	private controller?: ReadableStreamDefaultController<Uint8Array>;
	private sent = false;
	/** An n8n page that must keep its origin removed the sandbox CSP. */
	private sandboxRemoved = false;
	readonly completed = new Promise<void>((resolve) => this.once('finish', resolve));
	get headersSent() {
		return this.sent;
	}
	status(code: number) {
		this.statusCode = code;
		return this;
	}
	setHeader(name: string, value: string | number | readonly string[]) {
		if (Array.isArray(value)) {
			this.headers.delete(name);
			for (const entry of value) this.headers.append(name, entry);
		} else this.headers.set(name, String(value));
		return this;
	}
	getHeader(name: string) {
		return this.headers.get(name) ?? undefined;
	}
	removeHeader(name: string) {
		if (name.toLowerCase() === 'content-security-policy') this.sandboxRemoved = true;
		this.headers.delete(name);
	}
	set(name: string | Record<string, string>, value?: string) {
		if (typeof name === 'string') this.setHeader(name, value ?? '');
		else for (const [key, entry] of Object.entries(name)) this.setHeader(key, entry);
		return this;
	}
	header(name: string, value: string) {
		return this.setHeader(name, value);
	}
	type(value: string) {
		return this.setHeader('content-type', value.includes('/') ? value : `text/${value}`);
	}
	writeHead(code: number, headers?: Record<string, string | number | readonly string[]>) {
		this.statusCode = code;
		for (const [key, value] of Object.entries(headers ?? {})) this.setHeader(key, value);
		return this;
	}
	override _write(
		chunk: Buffer | string,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	) {
		this.sent = true;
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (this.controller) {
			try {
				this.controller.enqueue(buffer);
			} catch {
				// The caller disconnected. Stock drops writes to a closed socket too.
				this.controller = undefined;
			}
		} else if (!this.streamed) this.chunks.push(buffer);
		callback();
	}
	override _final(callback: (error?: Error | null) => void) {
		try {
			this.controller?.close();
		} catch {
			// The caller disconnected already.
		}
		this.controller = undefined;
		callback();
	}
	/**
	 * Sends the status and headers now, like a flushed Node response. Later writes go to the
	 * caller as they arrive, and `end()` closes the body.
	 */
	openStream(onCancel?: () => void) {
		if (this.writableEnded || this.streamed) return this;
		this.sent = true;
		this.streamed = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.controller = controller;
			},
			cancel: () => {
				this.controller = undefined;
				onCancel?.();
			},
		});
		for (const chunk of this.chunks.splice(0)) this.controller?.enqueue(chunk);
		return this;
	}
	json(body: unknown) {
		if (!this.headers.has('content-type'))
			this.setHeader('content-type', 'application/json; charset=utf-8');
		this.end(JSON.stringify(body));
		return this;
	}
	send(body?: unknown) {
		if (body === undefined || body === null) this.end();
		else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
			this.headers.has('content-type') || this.type('application/octet-stream');
			this.end(body);
		} else if (typeof body === 'object') return this.json(body);
		else {
			this.headers.has('content-type') || this.type('text/html; charset=utf-8');
			this.end(String(body));
		}
		return this;
	}
	sendStatus(code: number) {
		return this.status(code).send();
	}
	redirect(code: number | string, url?: string) {
		return this.status(typeof code === 'number' ? code : 302)
			.setHeader('location', url ?? String(code))
			.send();
	}
	render(view: string, data: Record<string, unknown> = {}) {
		return this.type('text/html; charset=utf-8').send(renderTemplate(view, data));
	}
	cookie(
		name: string,
		value: string,
		options: {
			httpOnly?: boolean;
			secure?: boolean;
			sameSite?: string;
			path?: string;
			maxAge?: number;
		} = {},
	) {
		const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
		if (options.httpOnly) parts.push('HttpOnly');
		if (options.secure) parts.push('Secure');
		if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
		if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
		this.headers.append('set-cookie', parts.join('; '));
		return this;
	}
	clearCookie(name: string, options = {}) {
		return this.cookie(name, '', { ...options, maxAge: 0 });
	}
	flushHeaders() {}
	/** Ends the response with a body that streams from `source`. */
	stream(source: AsyncIterable<Uint8Array | string>) {
		if (this.writableEnded || this.streamed) return this;
		this.headers.has('content-type') || this.type('application/octet-stream');
		this.sent = true;
		this.streamed = toWebStream(source);
		this.end();
		return this;
	}
	async capture(response: IExecuteResponsePromiseData): Promise<void> {
		if (this.writableEnded) return;
		this.sandboxRemoved = false;
		if ('statusCode' in response && typeof response.statusCode === 'number')
			this.status(response.statusCode);
		if ('headers' in response && response.headers && typeof response.headers === 'object') {
			for (const [key, value] of Object.entries(response.headers))
				if (value !== undefined) this.setHeader(key, String(value));
		}
		decodeBufferBody(response);
		const body = 'body' in response ? response.body : response;
		if (
			body &&
			typeof body === 'object' &&
			'binaryData' in body &&
			body.binaryData &&
			typeof body.binaryData === 'object' &&
			'id' in body.binaryData &&
			typeof body.binaryData.id === 'string'
		) {
			this.stream(await Container.get(BinaryDataService).getAsStream(body.binaryData.id));
		} else if (isAsyncIterable(body)) this.stream(body);
		else this.send(body);
	}
	asEngineResponse(): NonNullable<IWorkflowExecuteAdditionalData['httpResponse']> {
		return this as unknown as NonNullable<IWorkflowExecuteAdditionalData['httpResponse']>;
	}
	toResponse(method = 'GET') {
		if (!this.sandboxRemoved)
			applySandboxCSP(
				this.headers,
				this.locals.webhookSandboxSetting === 'form' ? 'form' : 'webhook',
			);
		// The runtime sets the framing headers of the body itself.
		for (const name of ['transfer-encoding', 'content-length', 'connection'])
			this.headers.delete(name);
		const empty = method === 'HEAD' || [204, 205, 304].includes(this.statusCode);
		if (empty) void this.streamed?.cancel();
		const body = empty ? null : (this.streamed ?? Buffer.concat(this.chunks));
		return new Response(body, { status: this.statusCode, headers: this.headers });
	}
}
