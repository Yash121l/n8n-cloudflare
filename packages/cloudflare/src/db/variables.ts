export interface VariableRow {
	id: string;
	key: string;
	type: string;
	value: string | null;
	projectId: string | null;
	projectName: string | null;
}

const SELECT = `SELECT v.id, v.key, v.type, v.value, v.projectId, p.name AS projectName
	FROM variables v LEFT JOIN project p ON p.id = v.projectId`;

export async function listVariables(db: D1Database): Promise<VariableRow[]> {
	const { results } = await db.prepare(`${SELECT} ORDER BY v.key`).all<VariableRow>();
	return results;
}

export async function findVariable(db: D1Database, id: string): Promise<VariableRow | null> {
	return await db.prepare(`${SELECT} WHERE v.id = ?`).bind(id).first<VariableRow>();
}

export async function variableKeyTaken(
	db: D1Database,
	key: string,
	projectId: string | null,
	exceptId?: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			"SELECT 1 AS found FROM variables WHERE key = ? AND COALESCE(projectId, '') = ? AND id != ?",
		)
		.bind(key, projectId ?? '', exceptId ?? '')
		.first();
	return row !== null;
}

export async function insertVariable(
	db: D1Database,
	variable: { id: string; key: string; type: string; value: string; projectId: string | null },
): Promise<void> {
	await db
		.prepare('INSERT INTO variables (id, key, type, value, projectId) VALUES (?, ?, ?, ?, ?)')
		.bind(variable.id, variable.key, variable.type, variable.value, variable.projectId)
		.run();
}

export async function updateVariable(
	db: D1Database,
	id: string,
	variable: { key: string; type: string; value: string; projectId: string | null },
): Promise<void> {
	await db
		.prepare('UPDATE variables SET key = ?, type = ?, value = ?, projectId = ? WHERE id = ?')
		.bind(variable.key, variable.type, variable.value, variable.projectId, id)
		.run();
}

export async function deleteVariable(db: D1Database, id: string): Promise<void> {
	await db.prepare('DELETE FROM variables WHERE id = ?').bind(id).run();
}
