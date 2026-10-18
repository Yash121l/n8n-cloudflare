import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Errors thrown by handlers become n8n's `{ code, message, hint? }` error body. */
export class HttpError extends Error {
	constructor(
		readonly status: ContentfulStatusCode,
		message: string,
		readonly hint?: string,
	) {
		super(message);
	}
}

export const badRequest = (message: string, hint?: string) => new HttpError(400, message, hint);
export const forbidden = (message = 'Forbidden') => new HttpError(403, message);
export const notFound = (message = 'Not Found') => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
