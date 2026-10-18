import { CreateOrUpdateTagRequestDto, RetrieveTagQueryDto } from '@n8n/api-types';
import { Hono } from 'hono';

import { requireUser } from '../../auth/middleware';
import { assertScope, globalScopesOf } from '../../auth/scopes';
import {
	deleteAnnotationTag,
	findAnnotationTagById,
	findAnnotationTagByName,
	insertAnnotationTag,
	listAnnotationTags,
	listAnnotationTagsWithUsage,
	renameAnnotationTag,
} from '../../db/annotations';
import type { AppEnv } from '../app';
import { ok } from '../app';
import { badRequest, notFound } from '../errors';
import { parseDto, queryParams, readJson } from '../http';

export const annotationTagRoutes = new Hono<AppEnv>();

const MAX_TAG_NAME_LENGTH = 24;

function validateName(name: string): void {
	if (name.length < 1 || name.length > MAX_TAG_NAME_LENGTH) {
		throw badRequest(`Tag name must be 1 to ${MAX_TAG_NAME_LENGTH} characters long.`);
	}
}

annotationTagRoutes.get('/annotation-tags', async (c) => {
	const user = requireUser(c);
	assertScope(globalScopesOf(user.roleSlug), 'annotationTag:list');
	const { withUsageCount } = parseDto(RetrieveTagQueryDto, queryParams(c));
	return ok(
		c,
		withUsageCount
			? await listAnnotationTagsWithUsage(c.env.DB)
			: await listAnnotationTags(c.env.DB),
	);
});

annotationTagRoutes.post('/annotation-tags', async (c) => {
	const user = requireUser(c);
	assertScope(globalScopesOf(user.roleSlug), 'annotationTag:create');
	const { name } = parseDto(CreateOrUpdateTagRequestDto, await readJson(c));
	validateName(name);
	if (await findAnnotationTagByName(c.env.DB, name))
		throw badRequest('Tag with this name already exists');
	return ok(c, await insertAnnotationTag(c.env.DB, name));
});

annotationTagRoutes.patch('/annotation-tags/:id', async (c) => {
	const user = requireUser(c);
	assertScope(globalScopesOf(user.roleSlug), 'annotationTag:update');
	const { name } = parseDto(CreateOrUpdateTagRequestDto, await readJson(c));
	validateName(name);
	const id = c.req.param('id');
	if (!(await findAnnotationTagById(c.env.DB, id))) throw notFound('Tag not found');
	const sameName = await findAnnotationTagByName(c.env.DB, name);
	if (sameName && sameName.id !== id) throw badRequest('Tag with this name already exists');
	await renameAnnotationTag(c.env.DB, id, name);
	return ok(c, await findAnnotationTagById(c.env.DB, id));
});

annotationTagRoutes.delete('/annotation-tags/:id', async (c) => {
	const user = requireUser(c);
	assertScope(globalScopesOf(user.roleSlug), 'annotationTag:delete');
	await deleteAnnotationTag(c.env.DB, c.req.param('id'));
	return ok(c, true);
});
