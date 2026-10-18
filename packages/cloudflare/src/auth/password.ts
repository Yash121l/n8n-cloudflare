import bcrypt from 'bcryptjs';

import type { UserRow } from '../db/types';
import { sha256Base64 } from './jwt';

const BCRYPT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
	return await bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
	if (!hash) return false;
	return await bcrypt.compare(password, hash);
}

/** Changes when the email or password changes, so old tokens stop working. */
export async function createJwtHash(
	user: Pick<UserRow, 'email' | 'password' | 'mfaEnabled' | 'mfaSecret'>,
): Promise<string> {
	const parts = [user.email ?? '', user.password ?? ''];
	if (user.mfaEnabled && user.mfaSecret) parts.push(user.mfaSecret.substring(0, 3));
	return (await sha256Base64(parts.join(':'))).substring(0, 10);
}

export function isEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
