import * as crypto from 'node:crypto';
import * as net from 'node:net';

type Update = (
	this: unknown,
	data: unknown,
	inputEncoding?: unknown,
	outputEncoding?: unknown,
) => unknown;

/** Node defaults string input to UTF-8 in `update`; workerd requires the encoding argument. */
function defaultUpdateEncoding(target: object) {
	const proto: { update?: Update } | null = Object.getPrototypeOf(target);
	if (!proto?.update || Reflect.get(proto, '__n8nPatched')) return;
	const original = proto.update;
	proto.update = function (data, inputEncoding, outputEncoding) {
		if (typeof data === 'string' && inputEncoding === undefined)
			return original.call(this, data, 'utf8');
		return original.call(this, data, inputEncoding, outputEncoding);
	};
	Reflect.set(proto, '__n8nPatched', true);
}

/** The Node error code that matches a workerd socket error message. */
function socketErrorCode(message: string): string {
	if (/cannot connect|refused|proxy request failed/i.test(message)) return 'ECONNREFUSED';
	if (/timed? ?out/i.test(message)) return 'ETIMEDOUT';
	if (/not found|resolve|dns/i.test(message)) return 'ENOTFOUND';
	return 'ECONNRESET';
}

/**
 * Node socket errors always have a `code`, like ECONNREFUSED. workerd socket errors have only a
 * message. Socket clients such as mqtt drop errors without a code and retry forever, so a
 * refused connection never fails the activation. This gives each socket error a Node code.
 */
function addSocketErrorCodes() {
	const proto: { emit: (this: unknown, event: string | symbol, ...args: unknown[]) => boolean } =
		net.Socket.prototype;
	if (Reflect.get(proto, '__n8nPatched')) return;
	const original = proto.emit;
	proto.emit = function (event, ...args) {
		const [error] = args;
		if (event === 'error' && error instanceof Error && !Reflect.get(error, 'code'))
			Reflect.set(error, 'code', socketErrorCode(error.message));
		return original.call(this, event, ...args);
	};
	Reflect.set(proto, '__n8nPatched', true);
}

/** Patches Node API differences that n8n code relies on. Runs once, at bootstrap. */
export function applyNodeCompat() {
	const key = Buffer.alloc(32);
	const iv = Buffer.alloc(16);
	defaultUpdateEncoding(crypto.createCipheriv('aes-256-cbc', key, iv));
	defaultUpdateEncoding(crypto.createDecipheriv('aes-256-cbc', key, iv));
	defaultUpdateEncoding(crypto.createHash('sha256'));
	defaultUpdateEncoding(crypto.createHmac('sha256', key));
	addSocketErrorCodes();
}
