import { badRequest } from './errors';
import type { AppContext } from './app';

interface DtoParser<T> {
	safeParse(
		data: unknown,
	): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } };
}

/** Validates data against an `@n8n/api-types` DTO. Failures become a 400 with the first issue. */
export function parseDto<T>(dto: DtoParser<T>, data: unknown): T {
	const result = dto.safeParse(data);
	if (!result.success) throw badRequest(result.error.issues[0]?.message ?? 'Invalid request');
	return result.data;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON body of the request, of any type. A missing or empty body reads as `undefined`. */
export async function readJsonValue(c: AppContext): Promise<unknown> {
	const text = await c.req.text();
	if (text === '') return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed;
	} catch {
		throw badRequest('Invalid JSON body');
	}
}

/** JSON body of the request. A missing or empty body reads as `{}`, like Express with body-parser. */
export async function readJson(c: AppContext): Promise<Record<string, unknown>> {
	const parsed = await readJsonValue(c);
	return isRecord(parsed) ? parsed : {};
}

/**
 * The editor sends object query params as JSON strings and arrays as `key[]=v`
 * (see `legacyParamSerializer` in the rest-api-client). This reads them back.
 */
export function queryParams(c: AppContext): Record<string, string | string[]> {
	const url = new URL(c.req.url);
	const out: Record<string, string | string[]> = {};
	for (const [rawKey, value] of url.searchParams) {
		if (rawKey.endsWith('[]')) {
			const key = rawKey.slice(0, -2);
			const current = out[key];
			out[key] = Array.isArray(current) ? [...current, value] : [value];
		} else {
			out[rawKey] = value;
		}
	}
	return out;
}

/** Parses a query param that holds a JSON value, e.g. `filter={"projectId":"x"}`. */
export function jsonQueryParam(value: string | string[] | undefined): unknown {
	if (typeof value !== 'string' || value === '') return undefined;
	try {
		return JSON.parse(value);
	} catch {
		throw badRequest('Invalid JSON in query parameter');
	}
}

export const asBool = (value: unknown): boolean => value === true || value === 'true';

export const toInt = (value: unknown, fallback: number): number => {
	const n =
		typeof value === 'string'
			? Number.parseInt(value, 10)
			: typeof value === 'number'
				? value
				: NaN;
	return Number.isFinite(n) ? n : fallback;
};
