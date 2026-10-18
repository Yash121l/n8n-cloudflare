import { newId } from './ids';
import { nowIso } from './types';

export const PROJECT_ROOT = '0';

export interface FolderRow {
	id: string;
	name: string;
	parentFolderId: string | null;
	projectId: string;
	createdAt: string;
	updatedAt: string;
}

export async function findFolderInProject(
	db: D1Database,
	folderId: string,
	projectId: string,
): Promise<FolderRow | null> {
	return await db
		.prepare('SELECT * FROM folder WHERE id = ? AND projectId = ?')
		.bind(folderId, projectId)
		.first<FolderRow>();
}

export async function insertFolder(
	db: D1Database,
	folder: { name: string; parentFolderId: string | null; projectId: string },
): Promise<FolderRow> {
	const now = nowIso();
	const row: FolderRow = { id: newId(), ...folder, createdAt: now, updatedAt: now };
	await db
		.prepare(
			'INSERT INTO folder (id, name, parentFolderId, projectId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
		)
		.bind(row.id, row.name, row.parentFolderId, row.projectId, now, now)
		.run();
	return row;
}

export async function updateFolder(
	db: D1Database,
	folderId: string,
	patch: { name?: string; parentFolderId?: string | null },
): Promise<void> {
	const sets: string[] = [];
	const values: Array<string | null> = [];
	if (patch.name !== undefined) {
		sets.push('name = ?');
		values.push(patch.name);
	}
	if (patch.parentFolderId !== undefined) {
		sets.push('parentFolderId = ?');
		values.push(patch.parentFolderId);
	}
	if (sets.length === 0) return;
	await db
		.prepare(`UPDATE folder SET ${sets.join(', ')}, updatedAt = ? WHERE id = ?`)
		.bind(...values, nowIso(), folderId)
		.run();
}

/** Ids of the folder and every folder below it. */
export async function folderAndDescendantIds(db: D1Database, folderId: string): Promise<string[]> {
	const { results } = await db
		.prepare(
			`WITH RECURSIVE tree(id) AS (
				SELECT ? UNION ALL SELECT f.id FROM folder f JOIN tree t ON f.parentFolderId = t.id
			) SELECT id FROM tree`,
		)
		.bind(folderId)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

/** The folder and its ancestors, root first. */
export async function folderPathToRoot(db: D1Database, folderId: string): Promise<FolderRow[]> {
	const { results } = await db
		.prepare(
			`WITH RECURSIVE path(id, depth) AS (
				SELECT id, 0 FROM folder WHERE id = ?
				UNION ALL SELECT f.parentFolderId, p.depth + 1 FROM folder f JOIN path p ON f.id = p.id WHERE f.parentFolderId IS NOT NULL
			) SELECT f.* FROM folder f JOIN path p ON p.id = f.id ORDER BY p.depth DESC`,
		)
		.bind(folderId)
		.all<FolderRow>();
	return results;
}

export async function folderContentCounts(
	db: D1Database,
	folderId: string,
): Promise<{ totalSubFolders: number; totalWorkflows: number }> {
	const ids = await folderAndDescendantIds(db, folderId);
	const workflows = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM workflow_entity
			WHERE isArchived = 0 AND parentFolderId IN (SELECT value FROM json_each(?))`,
		)
		.bind(JSON.stringify(ids))
		.first<{ n: number }>();
	return { totalSubFolders: ids.length - 1, totalWorkflows: workflows?.n ?? 0 };
}

export async function folderCounts(
	db: D1Database,
	folderIds: string[],
	isArchived: boolean | undefined,
): Promise<Map<string, { workflowCount: number; subFolderCount: number }>> {
	const out = new Map<string, { workflowCount: number; subFolderCount: number }>();
	if (folderIds.length === 0) return out;
	const ids = JSON.stringify(folderIds);
	const archivedClause = isArchived === undefined ? '' : `AND isArchived = ${isArchived ? 1 : 0}`;
	const workflows = await db
		.prepare(
			`SELECT parentFolderId AS id, COUNT(*) AS n FROM workflow_entity
			WHERE parentFolderId IN (SELECT value FROM json_each(?)) ${archivedClause} GROUP BY parentFolderId`,
		)
		.bind(ids)
		.all<{ id: string; n: number }>();
	const subFolders = await db
		.prepare(
			`SELECT parentFolderId AS id, COUNT(*) AS n FROM folder
			WHERE parentFolderId IN (SELECT value FROM json_each(?)) GROUP BY parentFolderId`,
		)
		.bind(ids)
		.all<{ id: string; n: number }>();
	for (const id of folderIds) out.set(id, { workflowCount: 0, subFolderCount: 0 });
	for (const row of workflows.results) {
		const entry = out.get(row.id);
		if (entry) entry.workflowCount = row.n;
	}
	for (const row of subFolders.results) {
		const entry = out.get(row.id);
		if (entry) entry.subFolderCount = row.n;
	}
	return out;
}

export async function deleteFolderMovingContent(
	db: D1Database,
	folderId: string,
	targetFolderId: string | null,
): Promise<void> {
	await db.batch([
		db
			.prepare('UPDATE folder SET parentFolderId = ? WHERE parentFolderId = ?')
			.bind(targetFolderId, folderId),
		db
			.prepare('UPDATE workflow_entity SET parentFolderId = ? WHERE parentFolderId = ?')
			.bind(targetFolderId, folderId),
		db.prepare('DELETE FROM folder WHERE id = ?').bind(folderId),
	]);
}
