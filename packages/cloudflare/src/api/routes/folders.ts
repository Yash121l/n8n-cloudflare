import {
	CreateFolderDto,
	DeleteFolderDto,
	ListFolderQueryDto,
	UpdateFolderDto,
} from '@n8n/api-types';
import { hasScope } from '@n8n/permissions';
import type { Scope } from '@n8n/permissions';
import { Hono } from 'hono';

import { requireUser } from '../../auth/middleware';
import { scopesForProject } from '../../auth/scopes';
import {
	PROJECT_ROOT,
	deleteFolderMovingContent,
	findFolderInProject,
	folderAndDescendantIds,
	folderContentCounts,
	folderCounts,
	folderPathToRoot,
	insertFolder,
	updateFolder,
} from '../../db/folders';
import type { FolderRow } from '../../db/folders';
import { findProjectById, userProjectRole } from '../../db/projects';
import type { ProjectRow, UserRow } from '../../db/types';
import { parseJson } from '../../db/types';
import { findWorkflowDocs } from '../../db/workflows';
import type { AppContext, AppEnv } from '../app';
import { ok, runContextOf } from '../app';
import { HttpError, badRequest, notFound } from '../errors';
import { parseDto, queryParams, readJson } from '../http';
import { archiveWorkflow } from '../workflow-actions';
import { MISSING_SCOPE } from '../workflow-view';

export const folderRoutes = new Hono<AppEnv>();

interface FolderItemOptions {
	isArchived?: boolean;
	includePath?: boolean;
}

/** Folders as the overview and the "move to folder" dialog list them. */
export async function folderListItems(
	db: D1Database,
	rows: ReadonlyArray<Pick<FolderRow, 'id' | 'name' | 'createdAt' | 'updatedAt'>>,
	options: FolderItemOptions = {},
): Promise<Array<Record<string, unknown>>> {
	if (rows.length === 0) return [];
	const ids = rows.map((r) => r.id);
	const { results: full } = await db
		.prepare(
			`SELECT f.id, f.parentFolderId, f.projectId, p.name AS projectName, p.type AS projectType, p.icon AS projectIcon,
				pf.name AS parentName, pf.parentFolderId AS parentParentId
			FROM folder f JOIN project p ON p.id = f.projectId LEFT JOIN folder pf ON pf.id = f.parentFolderId
			WHERE f.id IN (SELECT value FROM json_each(?))`,
		)
		.bind(JSON.stringify(ids))
		.all<{
			id: string;
			parentFolderId: string | null;
			projectId: string;
			projectName: string;
			projectType: string;
			projectIcon: string | null;
			parentName: string | null;
			parentParentId: string | null;
		}>();
	const byId = new Map(full.map((row) => [row.id, row]));
	const counts = await folderCounts(db, ids, options.isArchived);
	const items: Array<Record<string, unknown>> = [];
	for (const row of rows) {
		const extra = byId.get(row.id);
		if (!extra) continue;
		const item: Record<string, unknown> = {
			id: row.id,
			name: row.name,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			homeProject: {
				id: extra.projectId,
				name: extra.projectName,
				type: extra.projectType,
				icon: parseJson<unknown>(extra.projectIcon, null),
			},
			parentFolder: extra.parentFolderId
				? { id: extra.parentFolderId, name: extra.parentName, parentFolderId: extra.parentParentId }
				: null,
			tags: [],
			...(counts.get(row.id) ?? { workflowCount: 0, subFolderCount: 0 }),
		};
		if (options.includePath) {
			item.path = (await folderPathToRoot(db, row.id)).map((folder) => folder.name);
		}
		items.push(item);
	}
	return items;
}

async function loadProject(c: AppContext): Promise<ProjectRow> {
	const project = await findProjectById(c.env.DB, c.req.param('projectId') ?? '');
	if (!project) throw notFound('Project not found');
	return project;
}

async function requireProjectScope(
	c: AppContext,
	user: UserRow,
	project: ProjectRow,
	scope: Scope,
) {
	const role = await userProjectRole(c.env.DB, user.id, project.id);
	if (!hasScope(scope, { global: scopesForProject(user, role) })) {
		throw new HttpError(403, MISSING_SCOPE);
	}
}

async function requireFolder(c: AppContext, projectId: string): Promise<FolderRow> {
	const folderId = c.req.param('folderId') ?? '';
	const folder = await findFolderInProject(c.env.DB, folderId, projectId);
	if (!folder) throw notFound(`Could not find the folder: ${folderId}`);
	return folder;
}

folderRoutes.post('/projects/:projectId/folders', async (c) => {
	const user = requireUser(c);
	const project = await loadProject(c);
	await requireProjectScope(c, user, project, 'folder:create');
	const { name, parentFolderId } = parseDto(CreateFolderDto, await readJson(c));
	if (parentFolderId && parentFolderId !== PROJECT_ROOT) {
		if (!(await findFolderInProject(c.env.DB, parentFolderId, project.id))) {
			throw notFound(`Could not find the folder: ${parentFolderId}`);
		}
	}
	const folder = await insertFolder(c.env.DB, {
		name,
		parentFolderId: parentFolderId && parentFolderId !== PROJECT_ROOT ? parentFolderId : null,
		projectId: project.id,
	});
	const [item] = await folderListItems(c.env.DB, [folder]);
	return ok(c, item);
});

folderRoutes.get('/projects/:projectId/folders', async (c) => {
	const user = requireUser(c);
	const project = await loadProject(c);
	await requireProjectScope(c, user, project, 'folder:list');
	const query = parseDto(ListFolderQueryDto, queryParams(c));
	const filter = query.filter ?? {};

	const clauses = ['f.projectId = ?'];
	const bindings: Array<string | number> = [project.id];
	if (filter.name) {
		clauses.push("LOWER(f.name) LIKE LOWER(?) ESCAPE '\\'");
		bindings.push(`%${filter.name.replace(/[\\%_]/g, '\\$&')}%`);
	}
	if (filter.parentFolderId === PROJECT_ROOT) {
		clauses.push('f.parentFolderId IS NULL');
	} else if (filter.parentFolderId) {
		clauses.push('f.parentFolderId = ?');
		bindings.push(filter.parentFolderId);
	}
	if (filter.excludeFolderIdAndDescendants) {
		clauses.push('f.id NOT IN (SELECT value FROM json_each(?))');
		bindings.push(
			JSON.stringify(await folderAndDescendantIds(c.env.DB, filter.excludeFolderIdAndDescendants)),
		);
	}
	if (filter.tags && filter.tags.length > 0) clauses.push('1 = 0');

	const [column, order] = (query.sortBy ?? 'updatedAt:desc').split(':');
	const orderBy =
		column === 'name' ? 'LOWER(f.name)' : `f.${column === 'createdAt' ? 'createdAt' : 'updatedAt'}`;
	const where = clauses.join(' AND ');
	const { results } = await c.env.DB.prepare(
		`SELECT f.id, f.name, f.createdAt, f.updatedAt FROM folder f WHERE ${where}
			ORDER BY ${orderBy} ${order === 'asc' ? 'ASC' : 'DESC'}, f.id LIMIT ? OFFSET ?`,
	)
		.bind(...bindings, query.take, query.skip)
		.all<Pick<FolderRow, 'id' | 'name' | 'createdAt' | 'updatedAt'>>();
	const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM folder f WHERE ${where}`)
		.bind(...bindings)
		.first<{ n: number }>();

	const data = await folderListItems(c.env.DB, results, {
		isArchived: false,
		includePath: query.select?.path === true,
	});
	return c.json({ count: total?.n ?? 0, data });
});

folderRoutes.get('/projects/:projectId/folders/:folderId/tree', async (c) => {
	const user = requireUser(c);
	const project = await loadProject(c);
	await requireProjectScope(c, user, project, 'folder:read');
	const folder = await requireFolder(c, project.id);
	const path = await folderPathToRoot(c.env.DB, folder.id);
	interface Node {
		id: string;
		name: string;
		children: Node[];
	}
	let tree: Node | null = null;
	let leaf: Node | null = null;
	for (const item of path) {
		const node: Node = { id: item.id, name: item.name, children: [] };
		if (leaf) leaf.children = [node];
		else tree = node;
		leaf = node;
	}
	return ok(c, tree ? [tree] : []);
});

folderRoutes.get('/projects/:projectId/folders/:folderId/content', async (c) => {
	const user = requireUser(c);
	const project = await loadProject(c);
	await requireProjectScope(c, user, project, 'folder:read');
	const folder = await requireFolder(c, project.id);
	return ok(c, await folderContentCounts(c.env.DB, folder.id));
});

folderRoutes.get('/projects/:projectId/folders/:folderId/credentials', async (c) => {
	const user = requireUser(c);
	const project = await loadProject(c);
	await requireProjectScope(c, user, project, 'folder:read');
	await requireFolder(c, project.id);
	return ok(c, []);
});

folderRoutes.patch('/projects/:projectId/folders/:folderId', async (c) => {
	const user = requireUser(c);
	const project = await loadProject(c);
	await requireProjectScope(c, user, project, 'folder:update');
	const folder = await requireFolder(c, project.id);
	const { name, parentFolderId } = parseDto(UpdateFolderDto, await readJson(c));

	let newParent: string | null | undefined;
	if (parentFolderId) {
		if (parentFolderId === folder.id) throw badRequest('Cannot set a folder as its own parent');
		if (parentFolderId === PROJECT_ROOT) {
			newParent = null;
		} else {
			if (!(await findFolderInProject(c.env.DB, parentFolderId, project.id))) {
				throw notFound(`Could not find the folder: ${parentFolderId}`);
			}
			const below = await folderAndDescendantIds(c.env.DB, folder.id);
			if (below.includes(parentFolderId)) {
				throw badRequest(
					"Cannot set a folder's parent to a folder that is a descendant of the current folder",
				);
			}
			newParent = parentFolderId;
		}
	}
	await updateFolder(c.env.DB, folder.id, { name: name || undefined, parentFolderId: newParent });
	return ok(c, undefined);
});

folderRoutes.delete('/projects/:projectId/folders/:folderId', async (c) => {
	const user = requireUser(c);
	const project = await loadProject(c);
	await requireProjectScope(c, user, project, 'folder:delete');
	const folder = await requireFolder(c, project.id);
	const { transferToFolderId } = parseDto(DeleteFolderDto, queryParams(c));

	if (!transferToFolderId) {
		const ids = await folderAndDescendantIds(c.env.DB, folder.id);
		const { results: workflows } = await c.env.DB.prepare(
			'SELECT id FROM workflow_entity WHERE parentFolderId IN (SELECT value FROM json_each(?))',
		)
			.bind(JSON.stringify(ids))
			.all<{ id: string }>();
		for (const doc of await findWorkflowDocs(
			c.env.DB,
			workflows.map((w) => w.id),
		)) {
			if (!doc.isArchived) await archiveWorkflow(runContextOf(c), user, doc);
		}
		await c.env.DB.batch([
			c.env.DB.prepare(
				'UPDATE workflow_entity SET parentFolderId = NULL WHERE parentFolderId IN (SELECT value FROM json_each(?))',
			).bind(JSON.stringify(ids)),
			c.env.DB.prepare('DELETE FROM folder WHERE id = ?').bind(folder.id),
		]);
		return ok(c, undefined);
	}

	if (transferToFolderId === folder.id) {
		throw badRequest('Cannot transfer folder contents to the folder being deleted');
	}
	if (transferToFolderId !== PROJECT_ROOT) {
		if (!(await findFolderInProject(c.env.DB, transferToFolderId, project.id))) {
			throw notFound(`Could not find the folder: ${transferToFolderId}`);
		}
	}
	await deleteFolderMovingContent(
		c.env.DB,
		folder.id,
		transferToFolderId === PROJECT_ROOT ? null : transferToFolderId,
	);
	return ok(c, undefined);
});

folderRoutes.put('/projects/:projectId/folders/:folderId/transfer', () => {
	throw new HttpError(403, 'Plan lacks license for this feature');
});
