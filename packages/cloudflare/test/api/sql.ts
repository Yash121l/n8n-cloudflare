import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Instance } from './harness';

function databaseFile(instance: Instance): string {
	const dir = join(instance.persist, 'v3/d1/miniflare-D1DatabaseObject');
	const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
	if (!file) throw new Error('no D1 database file found');
	return join(dir, file);
}

/** Quotes a value as an SQL literal. Only for test fixtures. */
export const literal = (value: string | number | null): string =>
	value === null
		? 'NULL'
		: typeof value === 'number'
			? String(value)
			: `'${value.replace(/'/g, "''")}'`;

/** Query against the local D1 database of an instance, to inspect what the worker stored. */
export function queryDb(instance: Instance, sql: string): Array<Record<string, unknown>> {
	const out = execFileSync('sqlite3', ['-readonly', '-json', databaseFile(instance), sql], {
		encoding: 'utf8',
	});
	if (out.trim() === '') return [];
	const parsed: unknown = JSON.parse(out);
	if (!Array.isArray(parsed)) throw new Error('unexpected sqlite3 output');
	return parsed.filter(
		(row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
	);
}

/** Writes rows the REST layer cannot create itself, for example executions that the runtime writes. */
export function execDb(instance: Instance, sql: string): void {
	execFileSync('sqlite3', [databaseFile(instance), sql], { encoding: 'utf8' });
}

const NOW = '2026-10-01T10:00:00.000Z';

export interface TestMember {
	id: string;
	email: string;
	password: string;
	personalProjectId: string;
}

/** Inserts a user with a personal project directly, without the invite flow. Log in with `memberSession`. */
export async function insertMember(
	instance: Instance,
	name: string,
	roleSlug = 'global:member',
): Promise<TestMember> {
	const { default: bcrypt } = await import('bcryptjs');
	const password = 'Password123';
	const id = `user-${name}`;
	const email = `${name}@example.com`;
	const personalProjectId = `personal-${name}`;
	execDb(
		instance,
		`INSERT INTO user (id, email, firstName, lastName, password, roleSlug, createdAt, updatedAt)
		VALUES (${literal(id)}, ${literal(email)}, ${literal(name)}, 'Member', ${literal(await bcrypt.hash(password, 4))}, ${literal(roleSlug)}, ${literal(NOW)}, ${literal(NOW)});
		INSERT INTO project (id, name, type, creatorId, createdAt, updatedAt)
		VALUES (${literal(personalProjectId)}, ${literal(`${name} Member <${email}>`)}, 'personal', ${literal(id)}, ${literal(NOW)}, ${literal(NOW)});
		INSERT INTO project_relation (projectId, userId, role, createdAt, updatedAt)
		VALUES (${literal(personalProjectId)}, ${literal(id)}, 'project:personalOwner', ${literal(NOW)}, ${literal(NOW)})`,
	);
	return { id, email, password, personalProjectId };
}

export function insertTeamProject(
	instance: Instance,
	id: string,
	members: Record<string, string>,
): void {
	const relations = Object.entries(members)
		.map(
			([userId, role]) =>
				`INSERT INTO project_relation (projectId, userId, role, createdAt, updatedAt) VALUES (${literal(id)}, ${literal(userId)}, ${literal(role)}, ${literal(NOW)}, ${literal(NOW)});`,
		)
		.join('\n');
	execDb(
		instance,
		`INSERT INTO project (id, name, type, createdAt, updatedAt) VALUES (${literal(id)}, ${literal(id)}, 'team', ${literal(NOW)}, ${literal(NOW)});\n${relations}`,
	);
}

/** Keys in the local R2 bucket of an instance that start with `prefix`. */
export function r2Keys(instance: Instance, prefix: string): string[] {
	const dir = join(instance.persist, 'v3/r2/miniflare-R2BucketObject');
	const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
	if (!file) return [];
	const out = execFileSync(
		'sqlite3',
		[
			'-readonly',
			'-json',
			join(dir, file),
			`SELECT key FROM _mf_objects WHERE key LIKE ${literal(`${prefix}%`)} ORDER BY key`,
		],
		{ encoding: 'utf8' },
	);
	if (out.trim() === '') return [];
	const parsed: unknown = JSON.parse(out);
	if (!Array.isArray(parsed)) throw new Error('unexpected sqlite3 output');
	return parsed.flatMap((row) =>
		typeof row === 'object' && row !== null && 'key' in row ? [String(row.key)] : [],
	);
}
