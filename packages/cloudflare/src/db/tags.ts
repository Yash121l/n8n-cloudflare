import { newId } from './ids';
import { nowIso } from './types';

export interface TagRow {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
}

export interface TagWithCount extends TagRow {
	usageCount: number;
}

export async function listTags(db: D1Database): Promise<TagRow[]> {
	const { results } = await db
		.prepare('SELECT id, name, createdAt, updatedAt FROM tag_entity ORDER BY createdAt, id')
		.all<TagRow>();
	return results;
}

/** Usage counts skip archived workflows, as stock n8n does. */
export async function listTagsWithUsage(db: D1Database): Promise<TagWithCount[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.name, t.createdAt, t.updatedAt,
				(SELECT COUNT(*) FROM workflows_tags wt JOIN workflow_entity w ON w.id = wt.workflowId
					WHERE wt.tagId = t.id AND w.isArchived = 0) AS usageCount
			FROM tag_entity t ORDER BY t.createdAt, t.id`,
		)
		.all<TagWithCount>();
	return results;
}

export async function findTagByName(db: D1Database, name: string): Promise<TagRow | null> {
	return await db
		.prepare('SELECT id, name, createdAt, updatedAt FROM tag_entity WHERE name = ?')
		.bind(name)
		.first<TagRow>();
}

export async function findTagById(db: D1Database, id: string): Promise<TagRow | null> {
	return await db
		.prepare('SELECT id, name, createdAt, updatedAt FROM tag_entity WHERE id = ?')
		.bind(id)
		.first<TagRow>();
}

export async function insertTag(db: D1Database, name: string): Promise<TagRow> {
	const now = nowIso();
	const tag: TagRow = { id: newId(), name, createdAt: now, updatedAt: now };
	await db
		.prepare('INSERT INTO tag_entity (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)')
		.bind(tag.id, tag.name, now, now)
		.run();
	return tag;
}

export async function renameTag(db: D1Database, id: string, name: string): Promise<void> {
	await db
		.prepare('UPDATE tag_entity SET name = ?, updatedAt = ? WHERE id = ?')
		.bind(name, nowIso(), id)
		.run();
}

export async function deleteTag(db: D1Database, id: string): Promise<void> {
	await db.prepare('DELETE FROM tag_entity WHERE id = ?').bind(id).run();
}

export async function existingTagIds(db: D1Database, ids: string[]): Promise<string[]> {
	if (ids.length === 0) return [];
	const { results } = await db
		.prepare('SELECT id FROM tag_entity WHERE id IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(ids))
		.all<{ id: string }>();
	return results.map((r) => r.id);
}
