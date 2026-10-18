import {
	ActionResultRequestDto,
	GetNodeTypesByIdentifierRequestDto,
	OptionsRequestDto,
	ResourceLocatorRequestDto,
	ResourceMapperFieldsRequestDto,
} from '@n8n/api-types';
import { Hono } from 'hono';
import type { INodeTypeNameVersion } from 'n8n-workflow';

import { requireUser } from '../../auth/middleware';
import * as runtime from '../../runtime/service';
import type { DynamicParametersRequest } from '../../runtime/service';
import { ok, runContextOf } from '../app';
import type { AppEnv } from '../app';
import { badRequest } from '../errors';
import { isRecord, parseDto, readJson } from '../http';

export const nodeTypeRoutes = new Hono<AppEnv>();

function isNodeTypeNameVersion(value: unknown): value is INodeTypeNameVersion {
	return isRecord(value) && typeof value.name === 'string' && typeof value.version === 'number';
}

/** "n8n-nodes-base.httpRequest@4.2" -> name and version, as in stock `parseNodeTypeIdentifier`. */
function parseIdentifier(identifier: string): INodeTypeNameVersion | null {
	const at = identifier.lastIndexOf('@');
	if (at <= 0) return null;
	const version = Number.parseFloat(identifier.slice(at + 1));
	return Number.isFinite(version) ? { name: identifier.slice(0, at), version } : null;
}

nodeTypeRoutes.post('/node-types', async (c) => {
	requireUser(c);
	const { nodeInfos } = await readJson(c);
	if (
		nodeInfos !== undefined &&
		(!Array.isArray(nodeInfos) || !nodeInfos.every(isNodeTypeNameVersion))
	) {
		throw badRequest('nodeInfos must be a list of { name, version }');
	}
	return ok(
		c,
		nodeInfos === undefined || nodeInfos.length === 0
			? []
			: await runtime.getNodeTypeDescriptions(nodeInfos),
	);
});

nodeTypeRoutes.post('/node-types/by-identifier', async (c) => {
	requireUser(c);
	const { identifiers } = parseDto(GetNodeTypesByIdentifierRequestDto, await readJson(c));
	const parsed = identifiers.flatMap((identifier) => parseIdentifier(identifier) ?? []);
	return ok(c, parsed.length === 0 ? [] : await runtime.getNodeTypeDescriptions(parsed));
});
