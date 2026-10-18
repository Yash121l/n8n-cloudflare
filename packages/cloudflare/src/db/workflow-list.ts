import { accessibleProjects, projectAccessClause } from './access';
import { PROJECT_ROOT } from './folders';
import type { UserRow } from './types';

export interface WorkflowListFilter {
	ids?: string[];
	query?: string;
	active?: boolean;
	isArchived?: boolean;
	tags?: string[];
	projectId?: string;
	parentFolderId?: string;
	parentFolderIds?: string[];
	/** Restricts folders to these ids. An empty list matches no folder. */
	folderIds?: string[];
	nodeTypes?: string[];
	triggerNodeTypes?: string[];
}

export interface ListRow {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	projectId?: string;
}

export interface ListQuery {
	filter: WorkflowListFilter;
	sortBy?: string;
	skip?: number;
	take?: number;
	onlySharedWithMe?: boolean;
}

const SORT_COLUMNS = new Set(['name', 'createdAt', 'updatedAt']);

export function parseSortBy(
	sortBy: string | undefined,
	fallback: string,
): { column: string; direction: 'ASC' | 'DESC' } {
	const [column, order] = (sortBy ?? fallback).split(':');
	return {
		column: SORT_COLUMNS.has(column) ? column : 'updatedAt',
		direction: order?.toLowerCase() === 'desc' ? 'DESC' : 'ASC',
	};
}

const escapeLike = (word: string) => word.replace(/[\\%_]/g, '\\$&');

export function searchWords(query: string | undefined): string[] {
	return (query ?? '')
		.trim()
		.split(/\s+/)
		.filter((word) => word !== '');
}

/** Sorts rows the way the SQL list does, so folders and workflows can be merged. */
export function compareRows(column: string, direction: 'ASC' | 'DESC') {
	const sign = direction === 'ASC' ? 1 : -1;
	return (a: ListRow, b: ListRow): number => {
		const left =
			column === 'name' ? a.name.toLowerCase() : column === 'createdAt' ? a.createdAt : a.updatedAt;
		const right =
			column === 'name' ? b.name.toLowerCase() : column === 'createdAt' ? b.createdAt : b.updatedAt;
		if (left === right) return a.id < b.id ? -1 : 1;
		return left < right ? -sign : sign;
	};
}

interface Where {
	clauses: string[];
	bindings: Array<string | number>;
}

function visibleWorkflowsWhere(
	access: Awaited<ReturnType<typeof accessibleProjects>>,
	query: ListQuery,
	personalProjectId: string | null,
): Where {
	const where: Where = { clauses: [], bindings: [] };
	const shared = projectAccessClause(access, 's.projectId', 's.role');
	let sharedSql = `s.workflowId = w.id AND ${shared.sql}`;
	where.bindings.push(...shared.bindings);
	if (query.filter.projectId) {
		sharedSql += ' AND s.projectId = ?';
		where.bindings.push(query.filter.projectId);
	}
	if (query.onlySharedWithMe) {
		sharedSql += " AND s.role != 'workflow:owner' AND s.projectId = ?";
		where.bindings.push(personalProjectId ?? '');
	}
	where.clauses.push(`EXISTS (SELECT 1 FROM shared_workflow s WHERE ${sharedSql})`);
	return where;
}

function filterWhere(filter: WorkflowListFilter): Where {
	const where: Where = { clauses: [], bindings: [] };
	if (filter.ids) {
		where.clauses.push('w.id IN (SELECT value FROM json_each(?))');
		where.bindings.push(JSON.stringify(filter.ids));
	}
	for (const word of searchWords(filter.query)) {
		where.clauses.push(
			"(w.name LIKE ? ESCAPE '\\' OR COALESCE(w.description, '') LIKE ? ESCAPE '\\')",
		);
		where.bindings.push(`%${escapeLike(word)}%`, `%${escapeLike(word)}%`);
	}
	if (typeof filter.active === 'boolean') {
		where.clauses.push(
			filter.active ? 'w.activeVersionId IS NOT NULL' : 'w.activeVersionId IS NULL',
		);
	}
	if (typeof filter.isArchived === 'boolean') {
		where.clauses.push(`w.isArchived = ${filter.isArchived ? 1 : 0}`);
	}
	if (filter.tags && filter.tags.length > 0) {
		where.clauses.push(
			`(SELECT COUNT(DISTINCT t.name) FROM workflows_tags wt JOIN tag_entity t ON t.id = wt.tagId
				WHERE wt.workflowId = w.id AND t.name IN (SELECT value FROM json_each(?))) = ?`,
		);
		where.bindings.push(JSON.stringify(filter.tags), new Set(filter.tags).size);
	}
	if (filter.parentFolderId === PROJECT_ROOT) {
		where.clauses.push('w.parentFolderId IS NULL');
	} else if (filter.parentFolderId) {
		where.clauses.push('w.parentFolderId = ?');
		where.bindings.push(filter.parentFolderId);
	} else if (filter.parentFolderIds && filter.parentFolderIds.length > 0) {
		where.clauses.push('w.parentFolderId IN (SELECT value FROM json_each(?))');
		where.bindings.push(JSON.stringify(filter.parentFolderIds));
	}
	for (const types of [filter.nodeTypes, filter.triggerNodeTypes]) {
		if (types && types.length > 0) {
			where.clauses.push(
				"EXISTS (SELECT 1 FROM json_each(w.nodes) n WHERE json_extract(n.value, '$.type') IN (SELECT value FROM json_each(?)))",
			);
			where.bindings.push(JSON.stringify(types));
		}
	}
	return where;
}

/** Visible workflows that match the filter. Without `take`, every match is returned. */
export async function listWorkflowRows(
	db: D1Database,
	user: Pick<UserRow, 'id' | 'roleSlug'>,
	personalProjectId: string | null,
	query: ListQuery,
	defaultSort: string,
): Promise<{ rows: ListRow[]; count: number }> {
	const access = await accessibleProjects(db, user, 'workflow:read', 'workflow');
	const visible = visibleWorkflowsWhere(access, query, personalProjectId);
	const filtered = filterWhere(query.filter);
	const clauses = [...visible.clauses, ...filtered.clauses];
	const bindings = [...visible.bindings, ...filtered.bindings];
	const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

	const { column, direction } = parseSortBy(query.sortBy, defaultSort);
	const orderColumn = column === 'name' ? 'LOWER(w.name)' : `w.${column}`;
	const paging =
		query.take === undefined
			? ''
			: `LIMIT ${Math.trunc(query.take)} OFFSET ${Math.trunc(query.skip ?? 0)}`;

	const [list, total] = await Promise.all([
		db
			.prepare(
				`SELECT w.id, w.name, w.createdAt, w.updatedAt FROM workflow_entity w ${where}
				ORDER BY ${orderColumn} ${direction}, w.id ASC ${paging}`,
			)
			.bind(...bindings)
			.all<ListRow>(),
		db
			.prepare(`SELECT COUNT(*) AS n FROM workflow_entity w ${where}`)
			.bind(...bindings)
			.first<{ n: number }>(),
	]);
	return { rows: list.results, count: total?.n ?? 0 };
}

/** Ids of the workflows the user may read, used by the active workflows list. */
export async function readableActiveWorkflowIds(
	db: D1Database,
	user: Pick<UserRow, 'id' | 'roleSlug'>,
): Promise<string[]> {
	const access = await accessibleProjects(db, user, 'workflow:read', 'workflow');
	const shared = projectAccessClause(access, 's.projectId', 's.role');
	const { results } = await db
		.prepare(
			`SELECT w.id FROM workflow_entity w WHERE w.activeVersionId IS NOT NULL
			AND EXISTS (SELECT 1 FROM shared_workflow s WHERE s.workflowId = w.id AND ${shared.sql})`,
		)
		.bind(...shared.bindings)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

/** Visible folders that match the list filter. */
export async function listFolderRows(
	db: D1Database,
	user: Pick<UserRow, 'id' | 'roleSlug'>,
	filter: WorkflowListFilter,
): Promise<ListRow[]> {
	if (filter.tags && filter.tags.length > 0) return [];
	const access = await accessibleProjects(db, user, 'folder:list');
	const visible = projectAccessClause(access, 'f.projectId');
	const clauses = [visible.sql];
	const bindings = [...visible.bindings];
	if (filter.projectId) {
		clauses.push('f.projectId = ?');
		bindings.push(filter.projectId);
	}
	for (const word of searchWords(filter.query)) {
		clauses.push("f.name LIKE ? ESCAPE '\\'");
		bindings.push(`%${escapeLike(word)}%`);
	}
	if (filter.parentFolderId === PROJECT_ROOT) {
		clauses.push('f.parentFolderId IS NULL');
	} else if (filter.parentFolderId) {
		clauses.push('f.parentFolderId = ?');
		bindings.push(filter.parentFolderId);
	}
	if (filter.folderIds) {
		clauses.push('f.id IN (SELECT value FROM json_each(?))');
		bindings.push(JSON.stringify(filter.folderIds));
	}
	const { results } = await db
		.prepare(
			`SELECT f.id, f.name, f.createdAt, f.updatedAt, f.projectId FROM folder f WHERE ${clauses.join(' AND ')}`,
		)
		.bind(...bindings)
		.all<ListRow>();
	return results;
}
