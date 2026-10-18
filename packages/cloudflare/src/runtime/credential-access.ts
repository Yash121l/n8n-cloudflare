/**
 * Port of CredentialsPermissionChecker (packages/cli/src/executions/pre-execution-checks) and of the
 * credential checks in DynamicNodeParametersService.refineResourceIds. The credential sharing
 * feature flag of stock (`N8N_ENV_FEAT_CRED_SHARING`) is off here, as it is by default in stock.
 */
import { hasScope } from '@n8n/permissions';
import type { INode, INodeTypeDescription, INodeCredentials } from 'n8n-workflow';
import { UserError, getActiveCredentialTypes } from 'n8n-workflow';

import { globalScopesOf } from '../auth/scopes';
import { accessibleProjects, projectAccessClause } from '../db/access';
import type { ProjectRow, UserRow } from '../db/types';
import { nodeTypes } from './node-types';

/** Details of an error go to the editor as the hint, like `description` of an n8n error. */
export class CredentialAccessError extends UserError {
	constructor(
		message: string,
		description: string,
		readonly kind: 'invalid' | 'inaccessible',
		/** Stock InaccessibleCredentialError names the node, so the failed run shows it. */
		readonly node?: INode,
	) {
		super(message, { description });
	}
}

const invalidCredential = (node: INode) =>
	new CredentialAccessError(
		`Node "${node.name}" uses invalid credential`,
		'Please recreate the credential.',
		'invalid',
	);

const inaccessibleCredential = (node: INode, project: Pick<ProjectRow, 'type' | 'name'> | null) =>
	new CredentialAccessError(
		`Node "${node.name}" does not have access to the credential`,
		project === null || project.type === 'personal'
			? 'Please recreate the credential or ask its owner to share it with you.'
			: `Please make sure that the credential is shared with the project "${project.name}"`,
		'inaccessible',
		node,
	);

function activeCredentialTypes(node: INode): Set<string> | null {
	let description: INodeTypeDescription | null = null;
	try {
		description = nodeTypes.getByNameAndVersion(node.type, node.typeVersion).description;
	} catch {
		// An unknown node type means all credentials are checked.
	}
	return getActiveCredentialTypes(node, description);
}

/** Credential id to the nodes that use it. Throws for a reference without an id, like stock. */
export function mapCredentialIdsToNodes(nodes: INode[]): Map<string, INode[]> {
	const map = new Map<string, INode[]>();
	for (const node of nodes) {
		if (node.disabled === true || !node.credentials) continue;
		const active = activeCredentialTypes(node);
		for (const [type, credential] of Object.entries(node.credentials)) {
			if (!credential.id) {
				if (credential.__aiGatewayManaged === true) continue;
				throw invalidCredential(node);
			}
			if (active !== null && !active.has(type)) continue;
			map.set(credential.id, [...(map.get(credential.id) ?? []), node]);
		}
	}
	return map;
}

const jsonList = (values: string[]) => JSON.stringify(values);

async function globalCredentialIds(db: D1Database, ids: string[]): Promise<Set<string>> {
	const { results } = await db
		.prepare(
			'SELECT id FROM credentials_entity WHERE isGlobal = 1 AND id IN (SELECT value FROM json_each(?))',
		)
		.bind(jsonList(ids))
		.all<{ id: string }>();
	return new Set(results.map((r) => r.id));
}

/** The project that owns the workflow, or the project the run names when the workflow is unknown. */
async function homeProjectOf(
	db: D1Database,
	scope: { workflowId?: string; projectId?: string },
): Promise<ProjectRow | null> {
	if (scope.workflowId) {
		const row = await db
			.prepare(
				`SELECT p.* FROM shared_workflow s JOIN project p ON p.id = s.projectId
				WHERE s.workflowId = ? AND s.role = 'workflow:owner'`,
			)
			.bind(scope.workflowId)
			.first<ProjectRow>();
		if (row) return row;
	}
	if (scope.projectId) {
		return await db
			.prepare('SELECT * FROM project WHERE id = ?')
			.bind(scope.projectId)
			.first<ProjectRow>();
	}
	return null;
}

/** An owner or admin who holds a personal workflow may use every credential, as in stock. */
async function ownerMayUseAnyCredential(db: D1Database, project: ProjectRow): Promise<boolean> {
	if (project.type !== 'personal') return false;
	const owner = await db
		.prepare(
			`SELECT u.roleSlug FROM project_relation r JOIN user u ON u.id = r.userId
			WHERE r.projectId = ? AND r.role = 'project:personalOwner'`,
		)
		.bind(project.id)
		.first<{ roleSlug: string }>();
	return owner !== null && hasScope('credential:use', { global: globalScopesOf(owner.roleSlug) });
}

export interface WorkflowCredentialScope {
	workflowId?: string;
	/** Used when the workflow has no owner row, for example a workflow that is not saved yet. */
	projectId?: string;
}

/**
 * The ids among `credentialIds` that no project of the workflow carries. Global credentials are
 * usable by every project. Returns `homeProject: null` when the workflow and project are unknown.
 */
export async function findCredentialsUnusableByWorkflow(
	db: D1Database,
	scope: WorkflowCredentialScope,
	credentialIds: string[],
): Promise<{ homeProject: ProjectRow | null; inaccessibleIds: string[] }> {
	if (credentialIds.length === 0) return { homeProject: null, inaccessibleIds: [] };
	const homeProject = await homeProjectOf(db, scope);
	if (!homeProject) return { homeProject: null, inaccessibleIds: credentialIds };
	if (await ownerMayUseAnyCredential(db, homeProject)) return { homeProject, inaccessibleIds: [] };

	const { results } = await db
		.prepare(
			`SELECT DISTINCT s.credentialsId FROM shared_credentials s
			WHERE s.credentialsId IN (SELECT value FROM json_each(?))
			AND (s.projectId = ? OR s.projectId IN (SELECT projectId FROM shared_workflow WHERE workflowId = ?))`,
		)
		.bind(jsonList(credentialIds), homeProject.id, scope.workflowId ?? '')
		.all<{ credentialsId: string }>();
	const usable = new Set(results.map((r) => r.credentialsId));
	const missing = credentialIds.filter((id) => !usable.has(id));
	if (missing.length === 0) return { homeProject, inaccessibleIds: [] };
	const global = await globalCredentialIds(db, missing);
	return { homeProject, inaccessibleIds: missing.filter((id) => !global.has(id)) };
}

/** Throws the stock error for the first credential of `nodes` that the workflow cannot use. */
export async function checkWorkflowCredentials(
	db: D1Database,
	scope: WorkflowCredentialScope,
	nodes: INode[],
	actingUser?: Pick<UserRow, 'id' | 'roleSlug'>,
): Promise<void> {
	const idToNodes = mapCredentialIdsToNodes(nodes);
	if (idToNodes.size === 0) return;
	const ids = [...idToNodes.keys()];

	const { homeProject, inaccessibleIds } = await findCredentialsUnusableByWorkflow(db, scope, ids);
	if (homeProject === null && actingUser) {
		// A workflow that is not stored has no project, so the acting user answers instead.
		const rejected = await findCredentialsUnreadableByUser(db, actingUser, ids);
		if (rejected.length === 0) return;
		throw inaccessibleCredential(idToNodes.get(rejected[0])?.[0] ?? nodes[0], null);
	}
	if (inaccessibleIds.length === 0) return;
	throw inaccessibleCredential(idToNodes.get(inaccessibleIds[0])?.[0] ?? nodes[0], homeProject);
}

/**
 * The ids among `credentialIds` that the user cannot read: those that do not exist and those that
 * are not shared with a project where the user holds `credential:read`. Global credentials count
 * as readable.
 */
export async function findCredentialsUnreadableByUser(
	db: D1Database,
	user: Pick<UserRow, 'id' | 'roleSlug'>,
	credentialIds: string[],
): Promise<string[]> {
	if (credentialIds.length === 0) return [];
	const access = await accessibleProjects(db, user, 'credential:read', 'credential');
	let readable: Set<string>;
	if (access.all) {
		const { results } = await db
			.prepare('SELECT id FROM credentials_entity WHERE id IN (SELECT value FROM json_each(?))')
			.bind(jsonList(credentialIds))
			.all<{ id: string }>();
		readable = new Set(results.map((r) => r.id));
	} else {
		const clause = projectAccessClause(access, 's.projectId', 's.role');
		const { results } = await db
			.prepare(
				`SELECT DISTINCT s.credentialsId FROM shared_credentials s
				WHERE s.credentialsId IN (SELECT value FROM json_each(?)) AND ${clause.sql}`,
			)
			.bind(jsonList(credentialIds), ...clause.bindings)
			.all<{ credentialsId: string }>();
		readable = new Set(results.map((r) => r.credentialsId));
		const missing = credentialIds.filter((id) => !readable.has(id));
		for (const id of await globalCredentialIds(db, missing)) readable.add(id);
	}
	return credentialIds.filter((id) => !readable.has(id));
}

/** Credential ids that a dynamic-parameters request names. */
export function credentialIdsOfRequest(credentials: INodeCredentials | undefined): string[] {
	return Object.values(credentials ?? {}).flatMap((details) => (details.id ? [details.id] : []));
}
