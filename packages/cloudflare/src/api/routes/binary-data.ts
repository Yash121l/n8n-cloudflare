/** Port of packages/cli/src/controllers/binary-data.controller.ts. */
import { BinaryDataQueryDto, BinaryDataSignedQueryDto, ViewableMimeTypes } from '@n8n/api-types';
import { Hono } from 'hono';
import {
	FileNotFoundError,
	TEMP_EXECUTION_ID,
	getHtmlSandboxCSP,
	isValidNonDefaultMode,
	parseExecutionFileId,
} from 'n8n-core';
import type { Readable } from 'node:stream';

import { requireUser } from '../../auth/middleware';
import { accessibleProjects, projectAccessClause } from '../../db/access';
import type { UserRow } from '../../db/types';
import type { Env } from '../../env';
import { openBinaryDataStream, validateBinarySignedToken } from '../../runtime/service';
import type { BinaryMetadata } from '../../runtime/service';
import type { AppEnv } from '../app';
import { badRequest } from '../errors';
import { parseDto, queryParams } from '../http';

/** Authenticated route, mounted below the auth middleware. */
export const binaryDataRoutes = new Hono<AppEnv>();

/** The signed route needs no session, so it is mounted ahead of the auth middleware. */
export const signedBinaryDataRoutes = new Hono<AppEnv>();

function validateBinaryDataId(binaryDataId: string): void {
	if (!binaryDataId) throw badRequest('Missing binary data ID');
	const separator = binaryDataId.indexOf(':');
	if (separator === -1) throw badRequest('Malformed binary data ID');
	if (!isValidNonDefaultMode(binaryDataId.slice(0, separator)))
		throw badRequest('Invalid binary data mode');
	const path = binaryDataId.slice(separator + 1);
	if (path === '' || path === '/' || path === '//') throw badRequest('Malformed binary data ID');
	// The reader resolves the whole path, so a `..` segment could read another execution after the check passed.
	if (path.split(/[/\\]/).includes('..')) throw badRequest('Malformed binary data ID');
}

/** A binary belongs to an execution, so reading it needs `workflow:read` on the workflow of that execution. */
async function hasReadAccess(env: Env, user: UserRow, binaryDataId: string): Promise<boolean> {
	const location = parseExecutionFileId(binaryDataId.slice(binaryDataId.indexOf(':') + 1));
	if (!location) return false;

	let workflowId = location.workflowId;
	if (location.executionId !== TEMP_EXECUTION_ID) {
		if (!/^\d+$/.test(location.executionId)) return false;
		// The file path is not trusted. The execution row names its workflow.
		const row = await env.DB.prepare('SELECT workflowId FROM execution_entity WHERE id = ?')
			.bind(Number(location.executionId))
			.first<{ workflowId: string }>();
		if (!row) return false;
		workflowId = row.workflowId;
	}

	const access = await accessibleProjects(env.DB, user, 'workflow:read', 'workflow');
	const clause = projectAccessClause(access, 's.projectId', 's.role');
	const shared = await env.DB.prepare(
		`SELECT 1 AS found FROM shared_workflow s WHERE s.workflowId = ? AND ${clause.sql} LIMIT 1`,
	)
		.bind(workflowId, ...clause.bindings)
		.first();
	return shared !== null;
}

/** Node streams are async iterable, which is all the Response body needs. */
function toWebStream(readable: Readable): ReadableStream<Uint8Array> {
	const iterator = readable[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await iterator.next();
			if (done) controller.close();
			else
				controller.enqueue(
					value instanceof Uint8Array ? value : new TextEncoder().encode(String(value)),
				);
		},
		cancel() {
			readable.destroy();
		},
	});
}

function contentHeaders(
	action: 'view' | 'download',
	metadata: BinaryMetadata,
	fallback: { fileName?: string; mimeType?: string },
): Headers {
	const fileName = metadata.fileName ?? fallback.fileName;
	const mimeType = metadata.mimeType ?? fallback.mimeType;
	if (action === 'view' && (!mimeType || !ViewableMimeTypes.includes(mimeType.toLowerCase()))) {
		throw badRequest('Content not viewable');
	}
	const headers = new Headers();
	if (metadata.fileSize !== undefined) headers.set('Content-Length', String(metadata.fileSize));
	if (mimeType) headers.set('Content-Type', mimeType);
	headers.set('Content-Security-Policy', getHtmlSandboxCSP());
	if (action === 'download') {
		headers.set(
			'Content-Disposition',
			fileName ? `attachment; filename="${encodeURIComponent(fileName)}"` : 'attachment',
		);
	}
	return headers;
}

async function respond(
	env: Env,
	binaryDataId: string,
	action: 'view' | 'download',
	fallback: { fileName?: string; mimeType?: string } = {},
): Promise<Response> {
	try {
		const { stream, metadata } = await openBinaryDataStream(env, binaryDataId);
		try {
			return new Response(toWebStream(stream), {
				headers: contentHeaders(action, metadata, fallback),
			});
		} catch (error) {
			stream.destroy();
			throw error;
		}
	} catch (error) {
		if (error instanceof FileNotFoundError) return new Response(null, { status: 404 });
		throw error;
	}
}

binaryDataRoutes.get('/binary-data', async (c) => {
	const user = requireUser(c);
	const { id, action, fileName, mimeType } = parseDto(BinaryDataQueryDto, queryParams(c));
	validateBinaryDataId(id);
	if (!(await hasReadAccess(c.env, user, id))) return c.body(null, 404);
	return await respond(c.env, id, action, { fileName, mimeType });
});

signedBinaryDataRoutes.get('/binary-data/signed', async (c) => {
	const { token } = parseDto(BinaryDataSignedQueryDto, queryParams(c));
	let binaryDataId: string;
	try {
		binaryDataId = await validateBinarySignedToken(c.env, token);
	} catch (error) {
		throw badRequest(error instanceof Error ? error.message : 'Invalid token');
	}
	validateBinaryDataId(binaryDataId);
	return await respond(c.env, binaryDataId, 'download');
});
