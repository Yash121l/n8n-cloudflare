import { Buffer } from 'node:buffer';
import type { IExecuteFunctions } from 'n8n-workflow';

import { USER_CODE_MODULE } from './types';
import type { SandboxResult } from './types';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** Workers RPC turns a Buffer into a Uint8Array. Helpers and user code expect a Buffer. */
export function restoreBuffers(value: unknown): unknown {
	if (value instanceof Uint8Array) return Buffer.from(value);
	if (Array.isArray(value)) return value.map(restoreBuffers);
	if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, restoreBuffers(item)]),
		);
	}
	return value;
}

const STACK_HEADER = /^(?<type>\S.*?): (?<details>.+)$/;
const USER_FRAME = new RegExp(`\\(${USER_CODE_MODULE.replace('.', '\\.')}:(\\d+):\\d+\\)`);

/** Same output as ExecutionError of the task runner: message with `[line N]`, error type as description. */
export function toTaskError(error: unknown): NonNullable<SandboxResult['error']> {
	const message =
		isRecord(error) && typeof error.message === 'string'
			? error.message
			: String(JSON.stringify(error));
	const stack = isRecord(error) && typeof error.stack === 'string' ? error.stack : undefined;
	const rows = (stack ?? '').split(/\r?\n/);
	// VmCodeModule is the module wrapper from host.ts. It is not user code.
	const frames = rows.filter((row) => USER_FRAME.test(row) && !row.includes('VmCodeModule'));
	const userFrame =
		frames.find((row) => !row.includes('VmCodeWrapper')) ??
		frames.find((row) => row.includes('VmCodeWrapper'));
	const lineNumber = userFrame ? Number(USER_FRAME.exec(userFrame)?.[1]) : undefined;
	const header = rows.find((row) => STACK_HEADER.test(row))?.match(STACK_HEADER)?.groups;
	const type =
		header?.type ?? (isRecord(error) && typeof error.name === 'string' ? error.name : undefined);
	return {
		message: `${message} ${lineNumber === undefined ? '' : `[line ${lineNumber}]`}`.trim(),
		description: type && type.toLowerCase() !== 'error' ? type : null,
		...(lineNumber === undefined ? {} : { lineNumber }),
		...(stack === undefined ? {} : { stack }),
	};
}

const SYNTAX_ERROR = new RegExp(
	`Uncaught (?<type>\\w*Error): (?<details>.*)\\n\\s*at ${USER_CODE_MODULE.replace('.', '\\.')}:(?<line>\\d+):`,
);

/** A syntax error in user code fails the Worker start. The host then sees `Failed to start Worker: ...`. */
export function toStartupError(error: unknown): NonNullable<SandboxResult['error']> | undefined {
	const message = error instanceof Error ? error.message : '';
	const groups = SYNTAX_ERROR.exec(message)?.groups;
	if (!groups) return undefined;
	const lineNumber = Number(groups.line);
	return {
		message: `${groups.details} [line ${lineNumber}]`,
		description: groups.type,
		lineNumber,
	};
}

const hasLogNodeOutput = (value: object): value is { logNodeOutput(...args: unknown[]): void } =>
	'logNodeOutput' in value && typeof value.logNodeOutput === 'function';

/** Like the `logNodeOutput` RPC of the task runner. ExecuteContext implements it, but IExecuteFunctions does not declare it. */
export function logNodeOutput(functions: IExecuteFunctions, args: string[]) {
	if (hasLogNodeOutput(functions)) functions.logNodeOutput(...args);
	else functions.sendMessageToUI(args.join(' '));
}
