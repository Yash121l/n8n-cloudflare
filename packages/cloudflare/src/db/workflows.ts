import type {
	IConnections,
	INode,
	IPinData,
	IWorkflowGroup,
	IWorkflowSettings,
} from 'n8n-workflow';

import { nowIso, parseJson } from './types';
import type { ProjectRow, WorkflowRow } from './types';

export interface WorkflowDoc {
	id: string;
	name: string;
	description: string | null;
	active: boolean;
	isArchived: boolean;
	nodes: INode[];
	connections: IConnections;
	settings: IWorkflowSettings | null;
	staticData: unknown;
	meta: Record<string, unknown> | null;
	pinData: IPinData | null;
	nodeGroups: IWorkflowGroup[];
	versionId: string;
	activeVersionId: string | null;
	versionCounter: number;
	triggerCount: number;
	parentFolderId: string | null;
	createdAt: string;
	updatedAt: string;
}

export function rowToDoc(row: WorkflowRow): WorkflowDoc {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		active: row.active === 1,
		isArchived: row.isArchived === 1,
		nodes: parseJson<INode[]>(row.nodes, []),
		connections: parseJson<IConnections>(row.connections, {}),
		settings: parseJson<IWorkflowSettings | null>(row.settings, null),
		staticData: parseJson<unknown>(row.staticData, null),
		meta: parseJson<Record<string, unknown> | null>(row.meta, null),
		pinData: parseJson<IPinData | null>(row.pinData, null),
		nodeGroups: parseJson<IWorkflowGroup[]>(row.nodeGroups, []),
		versionId: row.versionId,
		activeVersionId: row.activeVersionId,
		versionCounter: row.versionCounter,
		triggerCount: row.triggerCount,
		parentFolderId: row.parentFolderId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

const toJson = (value: unknown): string | null =>
	value === null || value === undefined ? null : JSON.stringify(value);

export async function findWorkflowDoc(db: D1Database, id: string): Promise<WorkflowDoc | null> {
	const row = await db
		.prepare('SELECT * FROM workflow_entity WHERE id = ?')
		.bind(id)
		.first<WorkflowRow>();
	return row ? rowToDoc(row) : null;
}

export async function workflowExists(db: D1Database, id: string): Promise<boolean> {
	return (
		(await db.prepare('SELECT 1 AS found FROM workflow_entity WHERE id = ?').bind(id).first()) !==
		null
	);
}

export async function findWorkflowDocs(db: D1Database, ids: string[]): Promise<WorkflowDoc[]> {
	if (ids.length === 0) return [];
	const { results } = await db
		.prepare('SELECT * FROM workflow_entity WHERE id IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(ids))
		.all<WorkflowRow>();
	return results.map(rowToDoc);
}

export interface TagJson {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
}

export async function tagsForWorkflows(
	db: D1Database,
	workflowIds: string[],
): Promise<Map<string, TagJson[]>> {
	const out = new Map<string, TagJson[]>();
	if (workflowIds.length === 0) return out;
	const { results } = await db
		.prepare(
			`SELECT wt.workflowId, t.id, t.name, t.createdAt, t.updatedAt
			FROM workflows_tags wt JOIN tag_entity t ON t.id = wt.tagId
			WHERE wt.workflowId IN (SELECT value FROM json_each(?))
			ORDER BY t.name`,
		)
		.bind(JSON.stringify(workflowIds))
		.all<TagJson & { workflowId: string }>();
	for (const { workflowId, ...tag } of results) {
		out.set(workflowId, [...(out.get(workflowId) ?? []), tag]);
	}
	return out;
}

export interface SharedRef {
	workflowId: string;
	projectId: string;
	role: string;
	project: Pick<ProjectRow, 'id' | 'name' | 'type' | 'icon'>;
}

export async function sharedForWorkflows(
	db: D1Database,
	workflowIds: string[],
): Promise<Map<string, SharedRef[]>> {
	const out = new Map<string, SharedRef[]>();
	if (workflowIds.length === 0) return out;
	const { results } = await db
		.prepare(
			`SELECT s.workflowId, s.projectId, s.role, p.name, p.type, p.icon
			FROM shared_workflow s JOIN project p ON p.id = s.projectId
			WHERE s.workflowId IN (SELECT value FROM json_each(?))`,
		)
		.bind(JSON.stringify(workflowIds))
		.all<{
			workflowId: string;
			projectId: string;
			role: string;
			name: string;
			type: ProjectRow['type'];
			icon: string | null;
		}>();
	for (const row of results) {
		const ref: SharedRef = {
			workflowId: row.workflowId,
			projectId: row.projectId,
			role: row.role,
			project: { id: row.projectId, name: row.name, type: row.type, icon: row.icon },
		};
		out.set(row.workflowId, [...(out.get(row.workflowId) ?? []), ref]);
	}
	return out;
}

export interface FolderRef {
	id: string;
	name: string;
	parentFolderId: string | null;
}

export async function folderRefs(
	db: D1Database,
	folderIds: string[],
): Promise<Map<string, FolderRef>> {
	const out = new Map<string, FolderRef>();
	const ids = [...new Set(folderIds)];
	if (ids.length === 0) return out;
	const { results } = await db
		.prepare(
			'SELECT id, name, parentFolderId FROM folder WHERE id IN (SELECT value FROM json_each(?))',
		)
		.bind(JSON.stringify(ids))
		.all<FolderRef>();
	for (const row of results) out.set(row.id, row);
	return out;
}

export async function userProjectRoles(
	db: D1Database,
	userId: string,
): Promise<Map<string, string>> {
	const { results } = await db
		.prepare('SELECT projectId, role FROM project_relation WHERE userId = ?')
		.bind(userId)
		.all<{ projectId: string; role: string }>();
	return new Map(results.map((r) => [r.projectId, r.role]));
}

export interface NewWorkflowInput {
	doc: WorkflowDoc;
	projectId: string;
	tagIds: string[];
	authors: string;
	autosaved: boolean;
}

export interface HistoryInput {
	versionId: string;
	workflowId: string;
	nodes: INode[];
	connections: IConnections;
	nodeGroups: IWorkflowGroup[];
	authors: string;
	autosaved: boolean;
}

/** SQL condition that holds only after a guarded update changed the workflow row, with its bindings. */
export interface WriteGuard {
	sql: string;
	bindings: string[];
}

export function insertHistoryStatement(
	db: D1Database,
	h: HistoryInput,
	guard?: WriteGuard,
): D1PreparedStatement {
	const now = nowIso();
	return db
		.prepare(
			`INSERT INTO workflow_history (versionId, workflowId, nodes, connections, nodeGroups, authors, autosaved, createdAt, updatedAt)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?${guard ? ` WHERE ${guard.sql}` : ''}`,
		)
		.bind(
			h.versionId,
			h.workflowId,
			JSON.stringify(h.nodes),
			JSON.stringify(h.connections),
			JSON.stringify(h.nodeGroups),
			h.authors,
			h.autosaved ? 1 : 0,
			now,
			now,
			...(guard?.bindings ?? []),
		);
}

export function setTagsStatements(
	db: D1Database,
	workflowId: string,
	tagIds: string[],
	guard?: WriteGuard,
): D1PreparedStatement[] {
	const and = guard ? ` AND ${guard.sql}` : '';
	const extra = guard?.bindings ?? [];
	return [
		db.prepare(`DELETE FROM workflows_tags WHERE workflowId = ?${and}`).bind(workflowId, ...extra),
		...[...new Set(tagIds)].map((tagId) =>
			db
				.prepare(
					`INSERT INTO workflows_tags (workflowId, tagId) SELECT ?, id FROM tag_entity WHERE id = ?${and}`,
				)
				.bind(workflowId, tagId, ...extra),
		),
	];
}

export async function insertWorkflow(db: D1Database, input: NewWorkflowInput): Promise<void> {
	const { doc } = input;
	const now = nowIso();
	await db.batch([
		db
			.prepare(
				`INSERT INTO workflow_entity (id, name, description, active, isArchived, nodes, connections, settings,
					staticData, meta, pinData, nodeGroups, versionId, activeVersionId, versionCounter, triggerCount,
					parentFolderId, createdAt, updatedAt)
				VALUES (?, ?, ?, 0, 0, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 1, 0, ?, ?, ?)`,
			)
			.bind(
				doc.id,
				doc.name,
				doc.description,
				JSON.stringify(doc.nodes),
				JSON.stringify(doc.connections),
				toJson(doc.settings),
				toJson(doc.meta),
				toJson(doc.pinData),
				JSON.stringify(doc.nodeGroups),
				doc.versionId,
				doc.parentFolderId,
				now,
				now,
			),
		db
			.prepare(
				`INSERT INTO shared_workflow (workflowId, projectId, role, createdAt, updatedAt)
				VALUES (?, ?, 'workflow:owner', ?, ?)`,
			)
			.bind(doc.id, input.projectId, now, now),
		insertHistoryStatement(db, {
			versionId: doc.versionId,
			workflowId: doc.id,
			nodes: doc.nodes,
			connections: doc.connections,
			nodeGroups: doc.nodeGroups,
			authors: input.authors,
			autosaved: input.autosaved,
		}),
		...setTagsStatements(db, doc.id, input.tagIds),
	]);
}

export interface WorkflowContentUpdate {
	doc: WorkflowDoc;
	history?: HistoryInput;
	tagIds?: string[];
}

/**
 * Writes the content fields only. The active fields change through `setActiveVersion`.
 * The update is a compare-and-swap on `versionId` and `updatedAt` of the row that `previous` was read from.
 * History and tags are written only when the swap applied, all in one batch.
 * Returns false when another save changed the row first, and then nothing was written.
 */
export async function updateWorkflowContent(
	db: D1Database,
	previous: Pick<WorkflowDoc, 'versionId' | 'updatedAt'>,
	update: WorkflowContentUpdate,
): Promise<boolean> {
	const { doc } = update;
	const applied: WriteGuard = {
		sql: 'EXISTS (SELECT 1 FROM workflow_entity WHERE id = ? AND versionId = ? AND updatedAt = ?)',
		bindings: [doc.id, doc.versionId, doc.updatedAt],
	};
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE workflow_entity SET name = ?, description = ?, nodes = ?, connections = ?, settings = ?,
					meta = ?, pinData = ?, nodeGroups = ?, versionId = ?, parentFolderId = ?, updatedAt = ?
				WHERE id = ? AND versionId = ? AND updatedAt = ?`,
			)
			.bind(
				doc.name,
				doc.description,
				JSON.stringify(doc.nodes),
				JSON.stringify(doc.connections),
				toJson(doc.settings),
				toJson(doc.meta),
				toJson(doc.pinData),
				JSON.stringify(doc.nodeGroups),
				doc.versionId,
				doc.parentFolderId,
				doc.updatedAt,
				doc.id,
				previous.versionId,
				previous.updatedAt,
			),
	];
	if (update.history) statements.push(insertHistoryStatement(db, update.history, applied));
	if (update.tagIds) statements.push(...setTagsStatements(db, doc.id, update.tagIds, applied));
	const [swap] = await db.batch(statements);
	return (swap?.meta.changes ?? 0) > 0;
}

/** Keeps `updatedAt` as it is, because activation does not change the content. */
export async function setActiveVersion(
	db: D1Database,
	workflowId: string,
	activeVersionId: string | null,
): Promise<void> {
	await db
		.prepare('UPDATE workflow_entity SET active = ?, activeVersionId = ? WHERE id = ?')
		.bind(activeVersionId === null ? 0 : 1, activeVersionId, workflowId)
		.run();
}

export async function setArchived(
	db: D1Database,
	doc: WorkflowDoc,
	isArchived: boolean,
	versionId: string,
	history: HistoryInput,
): Promise<void> {
	await db.batch([
		insertHistoryStatement(db, history),
		db
			.prepare(
				`UPDATE workflow_entity SET isArchived = ?, versionId = ?,
					active = CASE WHEN ? = 1 THEN 0 ELSE active END,
					activeVersionId = CASE WHEN ? = 1 THEN NULL ELSE activeVersionId END
				WHERE id = ?`,
			)
			.bind(isArchived ? 1 : 0, versionId, isArchived ? 1 : 0, isArchived ? 1 : 0, doc.id),
	]);
}

export async function deleteWorkflow(db: D1Database, id: string): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM webhook_entity WHERE workflowId = ?').bind(id),
		db.prepare('DELETE FROM test_webhook WHERE workflowId = ?').bind(id),
		db.prepare('DELETE FROM execution_entity WHERE workflowId = ?').bind(id),
		db.prepare('DELETE FROM workflow_entity WHERE id = ?').bind(id),
	]);
}

export async function addPublishEvent(
	db: D1Database,
	event: {
		workflowId: string;
		versionId: string | null;
		event: 'activated' | 'deactivated';
		userId: string | null;
	},
): Promise<void> {
	await db
		.prepare(
			'INSERT INTO workflow_publish_history (workflowId, versionId, event, userId, createdAt) VALUES (?, ?, ?, ?, ?)',
		)
		.bind(event.workflowId, event.versionId, event.event, event.userId, nowIso())
		.run();
}

export async function uniqueWorkflowName(db: D1Database, requested: string): Promise<string> {
	const { results } = await db
		.prepare("SELECT name FROM workflow_entity WHERE name LIKE ? ESCAPE '\\'")
		.bind(`${requested.replace(/[\\%_]/g, '\\$&')}%`)
		.all<{ name: string }>();
	if (results.length === 0) return requested;
	if (results.length === 1) return `${requested} 2`;
	const maxSuffix = results.reduce((max, { name }) => {
		const suffix = Number.parseInt(name.split(`${requested} `)[1] ?? '', 10);
		return Number.isNaN(suffix) ? max : Math.max(max, suffix);
	}, 2);
	return `${requested} ${maxSuffix + 1}`;
}
