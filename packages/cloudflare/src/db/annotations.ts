import { newId } from './ids';
import { nowIso } from './types';

export interface AnnotationTagRow {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
}

export interface AnnotationTagWithCount extends AnnotationTagRow {
	usageCount: number;
}

export interface ExecutionAnnotation {
	id: number;
	vote: string | null;
	tags: Array<{ id: string; name: string }>;
}

const TAG_COLUMNS = 'id, name, createdAt, updatedAt';

export async function listAnnotationTags(db: D1Database): Promise<AnnotationTagRow[]> {
	const { results } = await db
		.prepare(`SELECT ${TAG_COLUMNS} FROM annotation_tag_entity ORDER BY createdAt, id`)
		.all<AnnotationTagRow>();
	return results;
}

export async function listAnnotationTagsWithUsage(
	db: D1Database,
): Promise<AnnotationTagWithCount[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.name, t.createdAt, t.updatedAt,
				(SELECT COUNT(*) FROM execution_annotation_tags m WHERE m.tagId = t.id) AS usageCount
			FROM annotation_tag_entity t ORDER BY t.createdAt, t.id`,
		)
		.all<AnnotationTagWithCount>();
	return results;
}

export async function findAnnotationTagByName(
	db: D1Database,
	name: string,
): Promise<AnnotationTagRow | null> {
	return await db
		.prepare(`SELECT ${TAG_COLUMNS} FROM annotation_tag_entity WHERE name = ?`)
		.bind(name)
		.first<AnnotationTagRow>();
}

export async function findAnnotationTagById(
	db: D1Database,
	id: string,
): Promise<AnnotationTagRow | null> {
	return await db
		.prepare(`SELECT ${TAG_COLUMNS} FROM annotation_tag_entity WHERE id = ?`)
		.bind(id)
		.first<AnnotationTagRow>();
}

export async function insertAnnotationTag(db: D1Database, name: string): Promise<AnnotationTagRow> {
	const now = nowIso();
	const tag: AnnotationTagRow = { id: newId(), name, createdAt: now, updatedAt: now };
	await db
		.prepare(
			'INSERT INTO annotation_tag_entity (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)',
		)
		.bind(tag.id, tag.name, now, now)
		.run();
	return tag;
}

export async function renameAnnotationTag(db: D1Database, id: string, name: string): Promise<void> {
	await db
		.prepare('UPDATE annotation_tag_entity SET name = ?, updatedAt = ? WHERE id = ?')
		.bind(name, nowIso(), id)
		.run();
}

export async function deleteAnnotationTag(db: D1Database, id: string): Promise<void> {
	await db.prepare('DELETE FROM annotation_tag_entity WHERE id = ?').bind(id).run();
}

export async function countAnnotationTags(db: D1Database, ids: string[]): Promise<number> {
	const row = await db
		.prepare(
			'SELECT COUNT(*) AS n FROM annotation_tag_entity WHERE id IN (SELECT value FROM json_each(?))',
		)
		.bind(JSON.stringify(ids))
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Port of ExecutionService.annotate. `vote` undefined leaves the stored vote alone, `tags` undefined leaves the tags alone. */
export async function annotateExecution(
	db: D1Database,
	executionId: number,
	update: { vote?: string | null; tags?: string[] },
): Promise<void> {
	const statements = [
		update.vote === undefined
			? db
					.prepare(
						'INSERT INTO execution_annotations (executionId) VALUES (?) ON CONFLICT (executionId) DO NOTHING',
					)
					.bind(executionId)
			: db
					.prepare(
						'INSERT INTO execution_annotations (executionId, vote) VALUES (?, ?) ON CONFLICT (executionId) DO UPDATE SET vote = excluded.vote',
					)
					.bind(executionId, update.vote),
	];
	if (update.tags) {
		statements.push(
			db
				.prepare(
					'DELETE FROM execution_annotation_tags WHERE annotationId = (SELECT id FROM execution_annotations WHERE executionId = ?)',
				)
				.bind(executionId),
		);
		const tags = [...new Set(update.tags)];
		if (tags.length > 0) {
			statements.push(
				db
					.prepare(
						`INSERT INTO execution_annotation_tags (annotationId, tagId)
						SELECT a.id, t.value FROM execution_annotations a, json_each(?) t WHERE a.executionId = ?`,
					)
					.bind(JSON.stringify(tags), executionId),
			);
		}
	}
	await db.batch(statements);
}

/** Annotations of the given executions. Executions without an annotation have no entry. */
export async function findAnnotations(
	db: D1Database,
	executionIds: number[],
): Promise<Map<number, ExecutionAnnotation>> {
	const map = new Map<number, ExecutionAnnotation>();
	if (executionIds.length === 0) return map;
	const ids = JSON.stringify(executionIds);
	const [annotations, tags] = await db.batch<Record<string, unknown>>([
		db
			.prepare(
				'SELECT id, executionId, vote FROM execution_annotations WHERE executionId IN (SELECT value FROM json_each(?))',
			)
			.bind(ids),
		db
			.prepare(
				`SELECT a.executionId, t.id, t.name FROM execution_annotations a
				JOIN execution_annotation_tags m ON m.annotationId = a.id
				JOIN annotation_tag_entity t ON t.id = m.tagId
				WHERE a.executionId IN (SELECT value FROM json_each(?)) ORDER BY t.createdAt, t.id`,
			)
			.bind(ids),
	]);
	for (const row of annotations.results as Array<{
		id: number;
		executionId: number;
		vote: string | null;
	}>) {
		map.set(row.executionId, { id: row.id, vote: row.vote, tags: [] });
	}
	for (const row of tags.results as Array<{ executionId: number; id: string; name: string }>) {
		map.get(row.executionId)?.tags.push({ id: row.id, name: row.name });
	}
	return map;
}
