import { findUserById } from '../db/users';
import type { UserRow } from '../db/types';
import type { Env } from '../env';
import { INVITE_AUDIENCE, PASSWORD_RESET_AUDIENCE, signToken, verifyToken } from './jwt';
import { jwtSecretOf } from './middleware';
import { createJwtHash } from './password';

const INVITE_TTL_SECONDS = 90 * 24 * 60 * 60;
const PASSWORD_RESET_TTL_SECONDS = 20 * 60;

/** Same link as `UsersController.generateInviteLink` in stock n8n. */
export async function inviteUrl(
	env: Env,
	baseUrl: string,
	inviterId: string,
	inviteeId: string,
): Promise<string> {
	const token = await signToken(
		await jwtSecretOf(env),
		{ inviterId, inviteeId },
		INVITE_AUDIENCE,
		INVITE_TTL_SECONDS,
	);
	return `${baseUrl}/signup?token=${token}`;
}

export async function verifyInviteToken(
	env: Env,
	token: string,
): Promise<{ inviterId: string; inviteeId: string } | null> {
	const payload = await verifyToken(await jwtSecretOf(env), token, INVITE_AUDIENCE);
	if (!payload || typeof payload.inviterId !== 'string' || typeof payload.inviteeId !== 'string')
		return null;
	if (!payload.inviterId || !payload.inviteeId) return null;
	return { inviterId: payload.inviterId, inviteeId: payload.inviteeId };
}

/** Same link as `AuthService.generatePasswordResetUrl`. The hash makes the token stop working once the password changes. */
export async function passwordResetUrl(env: Env, baseUrl: string, user: UserRow): Promise<string> {
	const token = await signToken(
		await jwtSecretOf(env),
		{ sub: user.id, hash: await createJwtHash(user) },
		PASSWORD_RESET_AUDIENCE,
		PASSWORD_RESET_TTL_SECONDS,
	);
	const url = new URL(`${baseUrl}/change-password`);
	url.searchParams.append('token', token);
	url.searchParams.append('mfaEnabled', String(user.mfaEnabled === 1));
	return url.toString();
}

export async function resolvePasswordResetToken(env: Env, token: string): Promise<UserRow | null> {
	const payload = await verifyToken(await jwtSecretOf(env), token, PASSWORD_RESET_AUDIENCE);
	if (!payload || typeof payload.sub !== 'string' || typeof payload.hash !== 'string') return null;
	const user = await findUserById(env.DB, payload.sub);
	if (!user || payload.hash !== (await createJwtHash(user))) return null;
	return user;
}
