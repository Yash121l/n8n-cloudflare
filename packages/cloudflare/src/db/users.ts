import { nowIso } from './types';
import type { UserRow } from './types';

export const OWNER_ROLE = 'global:owner';
export const ADMIN_ROLE = 'global:admin';
export const CHAT_USER_ROLE = 'global:chatUser';

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
	return await db.prepare('SELECT * FROM user WHERE id = ?').bind(id).first<UserRow>();
}

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
	return await db
		.prepare('SELECT * FROM user WHERE email = ?')
		.bind(email.toLowerCase())
		.first<UserRow>();
}

export async function findUsersByEmails(db: D1Database, emails: string[]): Promise<UserRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM user WHERE email IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(emails.map((email) => email.toLowerCase())))
		.all<UserRow>();
	return results;
}

export async function listUsers(db: D1Database): Promise<UserRow[]> {
	const { results } = await db.prepare('SELECT * FROM user ORDER BY createdAt').all<UserRow>();
	return results;
}

/** An owner is "claimed" once its row has an email, as in stock n8n. */
export async function hasClaimedOwner(db: D1Database): Promise<boolean> {
	const row = await db
		.prepare('SELECT COUNT(*) AS n FROM user WHERE roleSlug = ? AND email IS NOT NULL')
		.bind(OWNER_ROLE)
		.first<{ n: number }>();
	return (row?.n ?? 0) > 0;
}

export async function insertUser(
	db: D1Database,
	user: Pick<UserRow, 'id' | 'email' | 'firstName' | 'lastName' | 'password' | 'roleSlug'>,
): Promise<void> {
	const now = nowIso();
	await db
		.prepare(
			'INSERT INTO user (id, email, firstName, lastName, password, roleSlug, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(
			user.id,
			user.email,
			user.firstName,
			user.lastName,
			user.password,
			user.roleSlug,
			now,
			now,
		)
		.run();
}

export type UserPatch = Partial<
	Pick<
		UserRow,
		| 'email'
		| 'firstName'
		| 'lastName'
		| 'password'
		| 'personalizationAnswers'
		| 'settings'
		| 'lastActiveAt'
		| 'disabled'
	>
>;

const PATCHABLE: ReadonlyArray<keyof UserPatch> = [
	'email',
	'firstName',
	'lastName',
	'password',
	'personalizationAnswers',
	'settings',
	'lastActiveAt',
	'disabled',
];

export async function updateUser(db: D1Database, id: string, patch: UserPatch): Promise<void> {
	const columns = PATCHABLE.filter((key) => patch[key] !== undefined);
	if (columns.length === 0) return;
	const assignments = [...columns.map((key) => `${key} = ?`), 'updatedAt = ?'].join(', ');
	const values = columns.map((key) => patch[key] ?? null);
	await db
		.prepare(`UPDATE user SET ${assignments} WHERE id = ?`)
		.bind(...values, nowIso(), id)
		.run();
}

export async function isTokenInvalidated(db: D1Database, token: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT 1 AS found FROM invalid_auth_token WHERE token = ?')
		.bind(token)
		.first();
	return row !== null;
}

export async function invalidateToken(
	db: D1Database,
	token: string,
	expiresAt: Date,
): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM invalid_auth_token WHERE expiresAt < ?').bind(nowIso()),
		db
			.prepare('INSERT OR IGNORE INTO invalid_auth_token (token, expiresAt) VALUES (?, ?)')
			.bind(token, expiresAt.toISOString()),
	]);
}
