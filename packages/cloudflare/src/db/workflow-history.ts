import type { IConnections, INode, IWorkflowGroup } from 'n8n-workflow';

import { parseJson } from './types';

interface HistoryRow {
	versionId: string;
	workflowId: string;
	nodes: string;
	connections: string;
	nodeGroups: string;
	authors: string;
	name: string | null;
	description: string | null;
	autosaved: number;
	createdAt: string;
	updatedAt: string;
}

export interface PublishEventRow {
	id: number;
	workflowId: string;
	versionId: string | null;
	event: 'activated' | 'deactivated';
	userId: string | null;
	createdAt: string;
}

export interface HistoryListItem {
	versionId: string;
	workflowId: string;
	authors: string;
	name: string | null;
	description: string | null;
	autosaved: boolean;
	createdAt: string;
	updatedAt: string;
	workflowPublishHistory: PublishEventRow[];
}

export interface HistoryVersion extends HistoryListItem {
	nodes: INode[];
	connections: IConnections;
	nodeGroups: IWorkflowGroup[];
}

const toListItem = (row: HistoryRow, publish: PublishEventRow[]): HistoryListItem => ({
	versionId: row.versionId,
	workflowId: row.workflowId,
	authors: row.authors,
	name: row.name,
	description: row.description,
	autosaved: row.autosaved === 1,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
	workflowPublishHistory: publish,
});

/** The most recent activation of each version, which is all the history panel shows. */
async function latestActivations(
	db: D1Database,
	workflowId: string,
	versionIds: string[],
): Promise<Map<string, PublishEventRow>> {
	const out = new Map<string, PublishEventRow>();
	if (versionIds.length === 0) return out;
	const { results } = await db
		.prepare(
			`SELECT * FROM workflow_publish_history
			WHERE workflowId = ? AND event = 'activated' AND versionId IN (SELECT value FROM json_each(?))
			ORDER BY id ASC`,
		)
		.bind(workflowId, JSON.stringify(versionIds))
		.all<PublishEventRow>();
	for (const row of results) if (row.versionId) out.set(row.versionId, row);
	return out;
}

export async function listHistory(
	db: D1Database,
	workflowId: string,
	take: number,
	skip: number,
): Promise<HistoryListItem[]> {
	const { results } = await db
		.prepare(
			`SELECT versionId, workflowId, '[]' AS nodes, '{}' AS connections, '[]' AS nodeGroups, authors, name,
				description, autosaved, createdAt, updatedAt
			FROM workflow_history WHERE workflowId = ? ORDER BY createdAt DESC, versionId ASC LIMIT ? OFFSET ?`,
		)
		.bind(workflowId, take, skip)
		.all<HistoryRow>();
	const activations = await latestActivations(
		db,
		workflowId,
		results.map((r) => r.versionId),
	);
	return results.map((row) => {
		const activation = activations.get(row.versionId);
		return toListItem(row, activation ? [activation] : []);
	});
}

export async function findHistoryVersion(
	db: D1Database,
	workflowId: string,
	versionId: string,
): Promise<HistoryVersion | null> {
	const row = await db
		.prepare('SELECT * FROM workflow_history WHERE workflowId = ? AND versionId = ?')
		.bind(workflowId, versionId)
		.first<HistoryRow>();
	if (!row) return null;
	const activations = await latestActivations(db, workflowId, [versionId]);
	const activation = activations.get(versionId);
	return {
		...toListItem(row, activation ? [activation] : []),
		nodes: parseJson<INode[]>(row.nodes, []),
		connections: parseJson<IConnections>(row.connections, {}),
		nodeGroups: parseJson<IWorkflowGroup[]>(row.nodeGroups, []),
	};
}

export async function historyVersionsByIds(
	db: D1Database,
	workflowId: string,
	versionIds: string[],
): Promise<Array<{ versionId: string; createdAt: string }>> {
	if (versionIds.length === 0) return [];
	const { results } = await db
		.prepare(
			`SELECT versionId, createdAt FROM workflow_history
			WHERE workflowId = ? AND versionId IN (SELECT value FROM json_each(?))`,
		)
		.bind(workflowId, JSON.stringify(versionIds))
		.all<{ versionId: string; createdAt: string }>();
	return results;
}

export async function updateHistoryVersion(
	db: D1Database,
	workflowId: string,
	versionId: string,
	patch: { name?: string | null; description?: string | null },
): Promise<void> {
	const sets: string[] = [];
	const values: Array<string | null> = [];
	if (patch.name !== undefined) {
		sets.push('name = ?');
		values.push(patch.name);
	}
	if (patch.description !== undefined) {
		sets.push('description = ?');
		values.push(patch.description);
	}
	if (sets.length === 0) return;
	await db
		.prepare(
			`UPDATE workflow_history SET ${sets.join(', ')} WHERE workflowId = ? AND versionId = ?`,
		)
		.bind(...values, workflowId, versionId)
		.run();
}

export async function publishTimeline(
	db: D1Database,
	workflowId: string,
	offset: number,
	limit: number,
) {
	const { results } = await db
		.prepare(
			`SELECT p.id, p.workflowId, p.versionId, p.event, p.createdAt, p.userId,
				u.firstName AS firstName, u.lastName AS lastName, h.name AS versionName
			FROM workflow_publish_history p
			LEFT JOIN user u ON u.id = p.userId
			LEFT JOIN workflow_history h ON h.versionId = p.versionId
			WHERE p.workflowId = ? ORDER BY p.id DESC LIMIT ? OFFSET ?`,
		)
		.bind(workflowId, limit, offset)
		.all<
			PublishEventRow & {
				firstName: string | null;
				lastName: string | null;
				versionName: string | null;
			}
		>();
	return results.map((row) => ({
		id: row.id,
		workflowId: row.workflowId,
		versionId: row.versionId,
		event: row.event,
		createdAt: row.createdAt,
		userId: row.userId,
		user:
			row.userId !== null && row.firstName !== null
				? { firstName: row.firstName, lastName: row.lastName ?? '' }
				: null,
		versionName: row.versionName,
	}));
}
