import { parseJson } from './types';

export async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
	const row = await db
		.prepare('SELECT value FROM settings WHERE key = ?')
		.bind(key)
		.first<{ value: string }>();
	return row ? parseJson<T>(row.value, fallback) : fallback;
}

export async function setSetting(
	db: D1Database,
	key: string,
	value: unknown,
	loadOnStartup = false,
): Promise<void> {
	await setSettingStatement(db, key, value, loadOnStartup).run();
}

export function setSettingStatement(
	db: D1Database,
	key: string,
	value: unknown,
	loadOnStartup = false,
): D1PreparedStatement {
	return db
		.prepare(
			'INSERT INTO settings (key, value, loadOnStartup) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
		)
		.bind(key, JSON.stringify(value), loadOnStartup ? 1 : 0);
}
