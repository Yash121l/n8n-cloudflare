import {
	ChangePasswordRequestDto,
	DismissBannerRequestDto,
	LoginRequestDto,
	OwnerSetupRequestDto,
	PasswordUpdateRequestDto,
	ResolvePasswordTokenQueryDto,
	ResolveSignupTokenQueryDto,
	UserSelfSettingsUpdateRequestDto,
	UserUpdateRequestDto,
	passwordSchema,
} from '@n8n/api-types';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';

import { AUTH_COOKIE_NAME } from '../../auth/jwt';
import { clearAuthCookie, issueAuthCookie, requireUser } from '../../auth/middleware';
import { hashPassword, isEmail, verifyPassword } from '../../auth/password';
import { resolvePasswordResetToken } from '../../auth/tokens';
import { newUuid } from '../../db/ids';
import {
	findPersonalProject,
	personalProjectName,
	personalProjectStatements,
} from '../../db/projects';
import { getSetting, setSetting, setSettingStatement } from '../../db/settings';
import { nowIso, parseJson } from '../../db/types';
import {
	OWNER_ROLE,
	findUserByEmail,
	findUserById,
	hasClaimedOwner,
	invalidateToken,
	updateUser,
} from '../../db/users';
import type { AppEnv } from '../app';
import { ok } from '../app';
import { HttpError, badRequest, notFound } from '../errors';
import { isRecord, parseDto, readJson } from '../http';
import {
	limitLoginByEmail,
	limitLoginByIp,
	limitPasswordChange,
	limitTokenByIp,
} from '../rate-limit';
import { toPublicUser } from '../serializers';
import { invitationIds } from './users';

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/login', async (c) => {
	await limitLoginByIp(c);
	const { emailOrLdapLoginId, password } = parseDto(LoginRequestDto, await readJson(c));
	await limitLoginByEmail(c, emailOrLdapLoginId);
	if (!isEmail(emailOrLdapLoginId)) throw badRequest('Invalid email address');

	const user = await findUserByEmail(c.env.DB, emailOrLdapLoginId);
	const valid = user !== null && !user.disabled && (await verifyPassword(password, user.password));
	if (!user || !valid) {
		throw new HttpError(401, 'Wrong username or password. Do you have caps lock on?');
	}
	if (user.mfaEnabled) throw new HttpError(401, 'MFA Error');

	await issueAuthCookie(c, user, false);
	await updateUser(c.env.DB, user.id, { lastActiveAt: nowIso() });
	return ok(c, toPublicUser(user, { withScopes: true, mfaAuthenticated: false }));
});

authRoutes.get('/login', (c) => {
	const user = requireUser(c);
	return ok(c, toPublicUser(user, { withScopes: true, mfaAuthenticated: c.get('usedMfa') }));
});

authRoutes.post('/logout', async (c) => {
	const token = getCookie(c, AUTH_COOKIE_NAME);
	if (token) {
		const exp = decodeExpiry(token);
		if (exp) await invalidateToken(c.env.DB, token, new Date(exp * 1000));
	}
	clearAuthCookie(c);
	return ok(c, { loggedOut: true });
});

authRoutes.post('/owner/setup', async (c) => {
	const payload = parseDto(OwnerSetupRequestDto, await readJson(c));
	if (await hasClaimedOwner(c.env.DB)) throw badRequest('Instance owner already setup');

	const email = payload.email.toLowerCase();
	if (await findUserByEmail(c.env.DB, email)) throw badRequest('Instance owner already setup');

	const now = nowIso();
	const userId = newUuid();
	const password = await hashPassword(payload.password);
	const { statements } = personalProjectStatements(c.env.DB, {
		id: userId,
		email,
		firstName: payload.firstName,
		lastName: payload.lastName,
	});
	// One batch is one transaction. The unique owner index makes a concurrent second setup fail as a whole.
	try {
		await c.env.DB.batch([
			c.env.DB.prepare(
				'INSERT INTO user (id, email, firstName, lastName, password, roleSlug, lastActiveAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
			).bind(
				userId,
				email,
				payload.firstName,
				payload.lastName,
				password,
				OWNER_ROLE,
				now,
				now,
				now,
			),
			...statements,
			setSettingStatement(c.env.DB, 'userManagement.isInstanceOwnerSetUp', true, true),
		]);
	} catch (error) {
		if (isUniqueViolation(error)) throw badRequest('Instance owner already setup');
		throw error;
	}

	const owner = await findUserById(c.env.DB, userId);
	if (!owner) throw new HttpError(500, 'Owner could not be created');
	await issueAuthCookie(c, owner, false);
	return ok(c, toPublicUser(owner, { withScopes: true }));
});

authRoutes.post('/owner/dismiss-banner', async (c) => {
	requireUser(c);
	const { banner } = parseDto(DismissBannerRequestDto, await readJson(c));
	if (banner) {
		const dismissed = await getSetting<string[]>(c.env.DB, 'ui.banners.dismissed', []);
		if (!dismissed.includes(banner)) {
			await setSetting(c.env.DB, 'ui.banners.dismissed', [...dismissed, banner], true);
		}
	}
	return ok(c, undefined);
});

authRoutes.get('/resolve-signup-token', async (c) => {
	await limitTokenByIp(c);
	const { token } = parseDto(ResolveSignupTokenQueryDto, c.req.query());
	const { inviterId, inviteeId } = await invitationIds(c, token);
	const [inviter, invitee] = await Promise.all([
		findUserById(c.env.DB, inviterId),
		findUserById(c.env.DB, inviteeId),
	]);
	if (!inviter || !invitee) throw badRequest('Invalid invite URL');
	if (invitee.password)
		throw badRequest('The invitation was likely either deleted or already claimed');
	if (!inviter.email) throw badRequest('Invalid request');
	return ok(c, { inviter: { firstName: inviter.firstName, lastName: inviter.lastName } });
});

// Without email delivery stock n8n refuses this. The owner hands out a reset link from the users page instead.
authRoutes.post('/forgot-password', () => {
	throw new HttpError(
		422,
		'Email sending must be set up in order to request a password reset email',
	);
});

authRoutes.get('/resolve-password-token', async (c) => {
	await limitTokenByIp(c);
	const { token } = parseDto(ResolvePasswordTokenQueryDto, c.req.query());
	if (!(await resolvePasswordResetToken(c.env, token))) throw notFound('');
	return ok(c, undefined);
});

authRoutes.post('/change-password', async (c) => {
	await limitTokenByIp(c);
	const { token, password } = parseDto(ChangePasswordRequestDto, await readJson(c));
	const user = await resolvePasswordResetToken(c.env, token);
	if (!user) throw notFound('');
	await updateUser(c.env.DB, user.id, { password: await hashPassword(password) });
	const updated = await findUserById(c.env.DB, user.id);
	if (updated) await issueAuthCookie(c, updated, false);
	return ok(c, undefined);
});

authRoutes.patch('/me', async (c) => {
	const user = requireUser(c);
	const payload = parseDto(UserUpdateRequestDto, await readJson(c));
	await updateUser(c.env.DB, user.id, {
		firstName: payload.firstName ?? user.firstName,
		lastName: payload.lastName ?? user.lastName,
	});
	const updated = await findUserById(c.env.DB, user.id);
	if (!updated) throw new HttpError(404, 'User not found');

	const project = await findPersonalProject(c.env.DB, user.id);
	if (project) {
		await c.env.DB.prepare('UPDATE project SET name = ?, updatedAt = ? WHERE id = ?')
			.bind(personalProjectName(updated), nowIso(), project.id)
			.run();
	}
	return ok(c, toPublicUser(updated, { withScopes: true, mfaAuthenticated: c.get('usedMfa') }));
});

authRoutes.patch('/me/password', async (c) => {
	const user = requireUser(c);
	await limitPasswordChange(c, user.id);
	const { currentPassword, newPassword } = parseDto(PasswordUpdateRequestDto, await readJson(c));
	if (!user.password) throw badRequest('Requesting user not set up.');
	if (!(await verifyPassword(currentPassword, user.password))) {
		throw badRequest('Provided current password is incorrect.');
	}
	const validation = passwordSchema.safeParse(newPassword);
	if (!validation.success) {
		throw badRequest(validation.error.errors.map(({ message }) => message).join(' '));
	}

	await updateUser(c.env.DB, user.id, { password: await hashPassword(newPassword) });
	const updated = await findUserById(c.env.DB, user.id);
	if (updated) await issueAuthCookie(c, updated, c.get('usedMfa') ?? false);
	return ok(c, { success: true });
});

authRoutes.post('/me/survey', async (c) => {
	const user = requireUser(c);
	const answers = await readJson(c);
	if (Object.keys(answers).length === 0) throw badRequest('Personalization answers are mandatory');
	await updateUser(c.env.DB, user.id, { personalizationAnswers: JSON.stringify(answers) });
	return ok(c, { success: true });
});

authRoutes.patch('/me/settings', async (c) => {
	const user = requireUser(c);
	const payload = parseDto(UserSelfSettingsUpdateRequestDto, await readJson(c));
	const current = parseJson<Record<string, unknown>>(user.settings, {});
	const merged = { ...current, ...payload };
	await updateUser(c.env.DB, user.id, { settings: JSON.stringify(merged) });
	return ok(c, merged);
});

function isUniqueViolation(error: unknown): boolean {
	return (
		error instanceof Error &&
		/UNIQUE constraint failed/i.test(`${error.message} ${String(error.cause ?? '')}`)
	);
}

function decodeExpiry(token: string): number | undefined {
	try {
		const body = token.split('.')[1];
		const json: unknown = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
		return isRecord(json) && typeof json.exp === 'number' ? json.exp : undefined;
	} catch {
		return undefined;
	}
}
