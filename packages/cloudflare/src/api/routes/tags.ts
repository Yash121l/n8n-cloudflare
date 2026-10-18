import { CreateOrUpdateTagRequestDto, RetrieveTagQueryDto } from '@n8n/api-types';
import { Hono } from 'hono';

import { requireUser } from '../../auth/middleware';
import { assertScope, globalScopesOf } from '../../auth/scopes';
import {
	deleteTag,
	findTagById,
	findTagByName,
	insertTag,
	listTags,
	listTagsWithUsage,
	renameTag,
} from '../../db/tags';
import type { AppEnv } from '../app';
import { ok } from '../app';
import { badRequest, notFound } from '../errors';
import { parseDto, queryParams, readJson } from '../http';

export const tagRoutes = new Hono<AppEnv>();

const MAX_TAG_NAME_LENGTH = 24;

function validateName(name: string): void {
	if (name.length < 1 || name.length > MAX_TAG_NAME_LENGTH) {
		throw badRequest(`Tag name must be 1 to ${MAX_TAG_NAME_LENGTH} characters long.`);
	}
}

tagRoutes.get('/tags', async (c) => {
	const user = requireUser(c);
	assertScope(globalScopesOf(user.roleSlug), 'tag:list');
	const { withUsageCount } = parseDto(RetrieveTagQueryDto, queryParams(c));
	return ok(c, withUsageCount ? await listTagsWithUsage(c.env.DB) : await listTags(c.env.DB));
});

tagRoutes.post('/tags', async (c) => {
	const user = requireUser(c);
	assertScope(globalScopesOf(user.roleSlug), 'tag:create');
	const { name } = parseDto(CreateOrUpdateTagRequestDto, await readJson(c));
	validateName(name);
	if (await findTagByName(c.env.DB, name)) throw badRequest('Tag with this name already exists');
	return ok(c, await insertTag(c.env.DB, name));
});

tagRoutes.patch('/tags/:id', async (c) => {
	const user = requireUser(c);
	assertScope(globalScopesOf(user.roleSlug), 'tag:update');
	const { name } = parseDto(CreateOrUpdateTagRequestDto, await readJson(c));
	validateName(name);
	const id = c.req.param('id');
	if (!(await findTagById(c.env.DB, id))) throw notFound('Tag not found');
	const sameName = await findTagByName(c.env.DB, name);
	if (sameName && sameName.id !== id) throw badRequest('Tag with this name already exists');
	await renameTag(c.env.DB, id, name);
	return ok(c, await findTagById(c.env.DB, id));
});

tagRoutes.delete('/tags/:id', async (c) => {
	const user = requireUser(c);
	assertScope(globalScopesOf(user.roleSlug), 'tag:delete');
	await deleteTag(c.env.DB, c.req.param('id'));
	return ok(c, true);
});
