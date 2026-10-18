import {
	ActionResultRequestDto,
	OptionsRequestDto,
	ResourceLocatorRequestDto,
	ResourceMapperFieldsRequestDto,
} from '@n8n/api-types';
import { Hono } from 'hono';

import { requireUser } from '../../auth/middleware';
import type { UserRow } from '../../db/types';
import * as runtime from '../../runtime/service';
import type { DynamicParametersRequest } from '../../runtime/service';
import { ok, runContextOf } from '../app';
import type { AppEnv } from '../app';
import { parseDto, readJson } from '../http';

/**
 * Dynamic node parameter routes. They carry the user into the runtime, which refuses credentials
 * the user cannot read (stock: DynamicNodeParametersService.refineResourceIds).
 */
export const dynamicParameterRoutes = new Hono<AppEnv>();

function toRequest(
	user: UserRow,
	payload: Omit<DynamicParametersRequest, 'user'>,
): DynamicParametersRequest {
	return {
		user,
		nodeTypeAndVersion: payload.nodeTypeAndVersion,
		path: payload.path,
		currentNodeParameters: payload.currentNodeParameters,
		credentials: payload.credentials,
		methodName: payload.methodName,
	};
}

dynamicParameterRoutes.post('/dynamic-node-parameters/options', async (c) => {
	const user = requireUser(c);
	const payload = parseDto(OptionsRequestDto, await readJson(c));
	return ok(
		c,
		await runtime.getParameterOptions(runContextOf(c), {
			...toRequest(user, payload),
			loadOptions: payload.loadOptions,
		}),
	);
});

dynamicParameterRoutes.post('/dynamic-node-parameters/resource-locator-results', async (c) => {
	const user = requireUser(c);
	const payload = parseDto(ResourceLocatorRequestDto, await readJson(c));
	return ok(
		c,
		await runtime.getResourceLocatorResults(runContextOf(c), {
			...toRequest(user, payload),
			filter: payload.filter,
			paginationToken: payload.paginationToken,
		}),
	);
});

dynamicParameterRoutes.post('/dynamic-node-parameters/resource-mapper-fields', async (c) => {
	const user = requireUser(c);
	const payload = parseDto(ResourceMapperFieldsRequestDto, await readJson(c));
	return ok(c, await runtime.getResourceMappingFields(runContextOf(c), toRequest(user, payload)));
});

dynamicParameterRoutes.post('/dynamic-node-parameters/local-resource-mapper-fields', async (c) => {
	const user = requireUser(c);
	const payload = parseDto(ResourceMapperFieldsRequestDto, await readJson(c));
	return ok(
		c,
		await runtime.getLocalResourceMappingFields(runContextOf(c), toRequest(user, payload)),
	);
});

dynamicParameterRoutes.post('/dynamic-node-parameters/action-result', async (c) => {
	const user = requireUser(c);
	const payload = parseDto(ActionResultRequestDto, await readJson(c));
	return ok(
		c,
		await runtime.getActionResult(runContextOf(c), {
			...toRequest(user, payload),
			handler: payload.handler,
			payload: payload.payload,
		}),
	);
});
