import { FAVORITE_RESOURCE_TYPES } from '@n8n/api-types';
import type { FavoriteResourceType } from '@n8n/api-types';
import { Hono } from 'hono';

import { requireUser } from '../../../auth/middleware';
import { getSetting, setSetting } from '../../../db/settings';
import type { AppContext, AppEnv } from '../../app';
import { ok } from '../../app';
import { badRequest, notFound } from '../../errors';
import { readJson } from '../../http';

const MAX_FAVORITES = 200;

interface StoredFavorite {
	id: number;
	resourceId: string;
	resourceType: FavoriteResourceType;
}

interface FavoriteJson extends StoredFavorite {
	userId: string;
	resourceName: string;
	resourceProjectId?: string;
}

const isResourceType = (value: unknown): value is FavoriteResourceType =>
	FAVORITE_RESOURCE_TYPES.some((type) => type === value);

const keyOf = (userId: string) => `favorites:${userId}`;

async function load(c: AppContext, userId: string): Promise<StoredFavorite[]> {
	return await getSetting<StoredFavorite[]>(c.env.DB, keyOf(userId), []);
}

/** Name and project of a favorite target. Returns null when the target is gone or has no editor page here. */
async function describe(
	db: D1Database,
	favorite: StoredFavorite,
): Promise<{ name: string; projectId?: string } | null> {
	const { resourceId } = favorite;
	switch (favorite.resourceType) {
		case 'workflow': {
			const row = await db
				.prepare('SELECT name FROM workflow_entity WHERE id = ?')
				.bind(resourceId)
				.first<{ name: string }>();
			return row ? { name: row.name } : null;
		}
		case 'project': {
			const row = await db
				.prepare('SELECT name FROM project WHERE id = ?')
				.bind(resourceId)
				.first<{ name: string }>();
			return row ? { name: row.name } : null;
		}
		case 'folder': {
			const row = await db
				.prepare('SELECT name, projectId FROM folder WHERE id = ?')
				.bind(resourceId)
				.first<{ name: string; projectId: string }>();
			return row ? { name: row.name, projectId: row.projectId } : null;
		}
		default:
			return null;
	}
}

async function toJson(
	db: D1Database,
	userId: string,
	favorite: StoredFavorite,
): Promise<FavoriteJson | null> {
	const meta = await describe(db, favorite);
	if (!meta) return null;
	return {
		...favorite,
		userId,
		resourceName: meta.name,
		...(meta.projectId ? { resourceProjectId: meta.projectId } : {}),
	};
}

/** Per-user favorites, kept as one JSON array in the settings table (no extra migration). */
export const favoriteRoutes = new Hono<AppEnv>();

favoriteRoutes.get('/favorites', async (c) => {
	const user = requireUser(c);
	const stored = await load(c, user.id);
	const enriched = await Promise.all(stored.map((fav) => toJson(c.env.DB, user.id, fav)));
	return ok(
		c,
		enriched.filter((fav): fav is FavoriteJson => fav !== null),
	);
});

favoriteRoutes.post('/favorites', async (c) => {
	const user = requireUser(c);
	const body = await readJson(c);
	const { resourceId, resourceType } = body;
	if (typeof resourceId !== 'string' || !isResourceType(resourceType)) {
		throw badRequest('resourceId and resourceType are required');
	}

	const stored = await load(c, user.id);
	const existing = stored.find(
		(f) => f.resourceId === resourceId && f.resourceType === resourceType,
	);
	const favorite = existing ?? {
		id: stored.reduce((max, f) => Math.max(max, f.id), 0) + 1,
		resourceId,
		resourceType,
	};
	const json = await toJson(c.env.DB, user.id, favorite);
	if (!json) throw notFound(`${resourceType} with id "${resourceId}" not found`);

	if (!existing) {
		if (stored.length >= MAX_FAVORITES)
			throw badRequest(`Favorites limit of ${MAX_FAVORITES} reached`);
		await setSetting(c.env.DB, keyOf(user.id), [...stored, favorite]);
	}
	return ok(c, json);
});

favoriteRoutes.delete('/favorites/:resourceType/:resourceId', async (c) => {
	const user = requireUser(c);
	const { resourceType, resourceId } = c.req.param();
	if (!isResourceType(resourceType)) throw badRequest(`Invalid resourceType: ${resourceType}`);

	const stored = await load(c, user.id);
	const remaining = stored.filter(
		(f) => !(f.resourceId === resourceId && f.resourceType === resourceType),
	);
	if (remaining.length === stored.length) throw notFound('Favorite not found');
	await setSetting(c.env.DB, keyOf(user.id), remaining);
	return ok(c, true);
});
