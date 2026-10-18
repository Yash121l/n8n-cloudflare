import type { Scope } from '@n8n/permissions';

import { globalScopesOf } from '../auth/scopes';
import { parseJson } from '../db/types';
import type { ProjectRow, UserRow } from '../db/types';

export interface PublicUserJson {
	id: string;
	email: string | null;
	firstName: string | null;
	lastName: string | null;
	role: string;
	isOwner: boolean;
	isPending: boolean;
	signInType: 'email';
	disabled: boolean;
	mfaEnabled: boolean;
	mfaAuthenticated: boolean;
	settings: Record<string, unknown> | null;
	personalizationAnswers: Record<string, unknown> | null;
	createdAt: string;
	lastActiveAt: string | null;
	globalScopes?: Scope[];
}

/** Same shape as `UserService.toPublic` in stock n8n. */
export function toPublicUser(
	user: UserRow,
	options: { withScopes?: boolean; mfaAuthenticated?: boolean } = {},
): PublicUserJson {
	const publicUser: PublicUserJson = {
		id: user.id,
		email: user.email,
		firstName: user.firstName,
		lastName: user.lastName,
		role: user.roleSlug,
		isOwner: user.roleSlug === 'global:owner',
		isPending: user.password === null,
		signInType: 'email',
		disabled: user.disabled === 1,
		mfaEnabled: user.mfaEnabled === 1,
		mfaAuthenticated: options.mfaAuthenticated ?? false,
		settings: parseJson<Record<string, unknown> | null>(user.settings, null),
		personalizationAnswers: parseJson<Record<string, unknown> | null>(
			user.personalizationAnswers,
			null,
		),
		createdAt: user.createdAt,
		lastActiveAt: user.lastActiveAt,
	};
	if (options.withScopes) publicUser.globalScopes = globalScopesOf(user.roleSlug);
	return publicUser;
}

export interface ProjectJson {
	id: string;
	name: string;
	icon: Record<string, unknown> | null;
	type: 'personal' | 'team';
	description: string | null;
	createdAt: string;
	updatedAt: string;
}

export function toProjectJson(project: ProjectRow): ProjectJson {
	return {
		id: project.id,
		name: project.name,
		icon: parseJson<Record<string, unknown> | null>(project.icon, null),
		type: project.type,
		description: project.description,
		createdAt: project.createdAt,
		updatedAt: project.updatedAt,
	};
}
