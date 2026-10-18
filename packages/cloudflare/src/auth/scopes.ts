import {
	ALL_ROLES,
	CREDENTIALS_SHARING_SCOPE_MAP,
	GLOBAL_SCOPE_MAP,
	PROJECT_SCOPE_MAP,
	WORKFLOW_SHARING_SCOPE_MAP,
	combineScopes,
	hasScope,
} from '@n8n/permissions';
import type { AllRolesMap, Scope } from '@n8n/permissions';

import { HttpError } from '../api/errors';

function lookup<T extends Record<string, Scope[]>>(
	map: T,
	slug: string | null | undefined,
): Scope[] {
	if (!slug) return [];
	return Object.entries(map).find(([key]) => key === slug)?.[1] ?? [];
}

export const globalScopesOf = (roleSlug: string): Scope[] => lookup(GLOBAL_SCOPE_MAP, roleSlug);
export const projectScopesOf = (roleSlug: string | null): Scope[] =>
	lookup(PROJECT_SCOPE_MAP, roleSlug);
export const workflowSharingScopesOf = (roleSlug: string | null): Scope[] =>
	lookup(WORKFLOW_SHARING_SCOPE_MAP, roleSlug);
export const credentialSharingScopesOf = (roleSlug: string | null): Scope[] =>
	lookup(CREDENTIALS_SHARING_SCOPE_MAP, roleSlug);

export interface ScopeSubject {
	roleSlug: string;
}

/** Scopes the user holds on a project. `projectRole` is the user's role in that project, if any. */
export function scopesForProject(user: ScopeSubject, projectRole: string | null): Scope[] {
	return [
		...combineScopes({
			global: globalScopesOf(user.roleSlug),
			project: projectScopesOf(projectRole),
		}),
	];
}

export interface SharingRef {
	projectId: string;
	role: string;
}

/**
 * Scopes the user holds on a workflow or credential, like `RoleService.combineResourceScopes` in stock n8n.
 * A sharing counts only when the user belongs to the project. Then the project role is masked by the
 * sharing role, so a viewer in a project that holds a credential as owner still cannot update it.
 */
export function resourceScopes(
	user: ScopeSubject,
	kind: 'workflow' | 'credential',
	sharings: ReadonlyArray<SharingRef>,
	projectRoles: ReadonlyMap<string, string>,
): Scope[] {
	const global = globalScopesOf(user.roleSlug);
	const scopes = new Set<Scope>(global);
	for (const sharing of sharings) {
		const projectRole = projectRoles.get(sharing.projectId);
		if (projectRole === undefined) continue;
		const mask =
			kind === 'workflow'
				? workflowSharingScopesOf(sharing.role)
				: credentialSharingScopesOf(sharing.role);
		const merged = combineScopes(
			{ global, project: projectScopesOf(projectRole) },
			{ sharing: mask },
		);
		for (const scope of merged) scopes.add(scope);
	}
	return [...scopes];
}

/** Sharing roles of a resource kind whose scopes include `scope`. */
export function sharingRolesWithScope(kind: 'workflow' | 'credential', scope: Scope): string[] {
	const map = kind === 'workflow' ? WORKFLOW_SHARING_SCOPE_MAP : CREDENTIALS_SHARING_SCOPE_MAP;
	return Object.entries(map)
		.filter(([, scopes]) => scopes.includes(scope))
		.map(([role]) => role);
}

export function assertScope(scopes: Scope[], required: Scope | Scope[]): void {
	if (!hasScope(required, { global: scopes })) {
		throw new HttpError(403, 'Forbidden');
	}
}

export const allRoles = (): AllRolesMap => ({
	global: [...ALL_ROLES.global],
	project: [...ALL_ROLES.project],
	credential: [...ALL_ROLES.credential],
	workflow: [...ALL_ROLES.workflow],
	secretsProviderConnection: [...ALL_ROLES.secretsProviderConnection],
});
