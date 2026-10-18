import type { Scope } from '@n8n/permissions';
import { calculateWorkflowChecksum } from 'n8n-workflow';
import type { INode } from 'n8n-workflow';

import { resourceScopes } from '../auth/scopes';
import { findHistoryVersion } from '../db/workflow-history';
import {
	findWorkflowDoc,
	folderRefs,
	sharedForWorkflows,
	tagsForWorkflows,
	userProjectRoles,
} from '../db/workflows';
import type { FolderRef, SharedRef, TagJson, WorkflowDoc } from '../db/workflows';
import type { UserRow } from '../db/types';
import { HttpError, notFound } from './errors';

export const MISSING_SCOPE = 'User is missing a scope required to perform this action';

export interface WorkflowAccess {
	doc: WorkflowDoc;
	shared: SharedRef[];
	scopes: Scope[];
}

/** Scopes the user holds on a workflow, see `resourceScopes`. */
export function workflowScopes(
	user: Pick<UserRow, 'roleSlug'>,
	shared: ReadonlyArray<Pick<SharedRef, 'projectId' | 'role'>>,
	projectRoles: ReadonlyMap<string, string>,
): Scope[] {
	return resourceScopes(user, 'workflow', shared, projectRoles);
}

export async function loadWorkflowAccess(
	db: D1Database,
	user: UserRow,
	id: string,
): Promise<WorkflowAccess | null> {
	const [doc, sharedById, roles] = await Promise.all([
		findWorkflowDoc(db, id),
		sharedForWorkflows(db, [id]),
		userProjectRoles(db, user.id),
	]);
	if (!doc) return null;
	const shared = sharedById.get(id) ?? [];
	return { doc, shared, scopes: workflowScopes(user, shared, roles) };
}

/** Loads a workflow and checks one scope, answering like the `@ProjectScope` decorator of stock n8n. */
export async function requireWorkflow(
	db: D1Database,
	user: UserRow,
	id: string,
	scope: Scope,
): Promise<WorkflowAccess> {
	const access = await loadWorkflowAccess(db, user, id);
	if (!access) throw notFound(`Workflow with ID "${id}" not found.`);
	if (!access.scopes.includes(scope)) throw new HttpError(403, MISSING_SCOPE);
	return access;
}

export async function checksumOf(doc: WorkflowDoc): Promise<string> {
	return await calculateWorkflowChecksum({
		name: doc.name,
		description: doc.description,
		nodes: doc.nodes,
		connections: doc.connections,
		settings: doc.settings ?? undefined,
		meta: doc.meta ?? undefined,
		pinData: doc.pinData ?? undefined,
		isArchived: doc.isArchived,
		activeVersionId: doc.activeVersionId,
		nodeGroups: doc.nodeGroups,
	});
}

export function ownership(shared: readonly SharedRef[]) {
	let homeProject: SharedRef['project'] | null = null;
	const sharedWithProjects: Array<SharedRef['project']> = [];
	for (const ref of shared) {
		if (ref.role === 'workflow:owner') homeProject = ref.project;
		else sharedWithProjects.push(ref.project);
	}
	const toJson = (project: SharedRef['project']) => ({
		id: project.id,
		type: project.type,
		name: project.name,
		icon: project.icon === null ? null : parseIcon(project.icon),
	});
	return {
		homeProject: homeProject === null ? null : toJson(homeProject),
		sharedWithProjects: sharedWithProjects.map(toJson),
	};
}

function parseIcon(icon: string): unknown {
	try {
		return JSON.parse(icon);
	} catch {
		return null;
	}
}

export function addNodeIds(nodes: INode[]): void {
	for (const node of nodes) {
		if (typeof node.id !== 'string' || node.id === '') node.id = crypto.randomUUID();
	}
}

export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
	}
	const left = Object.entries(a).filter(([, v]) => v !== undefined);
	const right = Object.entries(b).filter(([, v]) => v !== undefined);
	if (left.length !== right.length) return false;
	const rightMap = new Map(right);
	return left.every(([key, value]) => rightMap.has(key) && deepEqual(value, rightMap.get(key)));
}

export interface SerializeExtras {
	tags?: TagJson[];
	parentFolder?: FolderRef | null;
}

/** The workflow as `GET /workflows/:id` returns it, which is `IWorkflowDb` in the editor. */
export async function serializeWorkflow(
	db: D1Database,
	access: WorkflowAccess,
	extras: SerializeExtras = {},
): Promise<Record<string, unknown>> {
	const { doc } = access;
	const tags = extras.tags ?? (await tagsForWorkflows(db, [doc.id])).get(doc.id) ?? [];
	const parentFolder =
		extras.parentFolder !== undefined
			? extras.parentFolder
			: doc.parentFolderId
				? ((await folderRefs(db, [doc.parentFolderId])).get(doc.parentFolderId) ?? null)
				: null;
	const activeVersion = doc.activeVersionId
		? await findHistoryVersion(db, doc.id, doc.activeVersionId)
		: null;
	const { homeProject, sharedWithProjects } = ownership(access.shared);
	return {
		id: doc.id,
		name: doc.name,
		description: doc.description,
		active: doc.active,
		isArchived: doc.isArchived,
		createdAt: doc.createdAt,
		updatedAt: doc.updatedAt,
		nodes: doc.nodes,
		connections: doc.connections,
		settings: doc.settings,
		meta: doc.meta,
		pinData: doc.pinData,
		nodeGroups: doc.nodeGroups,
		versionId: doc.versionId,
		activeVersionId: doc.activeVersionId,
		activeVersion,
		versionCounter: doc.versionCounter,
		triggerCount: doc.triggerCount,
		parentFolder,
		tags,
		homeProject,
		sharedWithProjects,
		scopes: access.scopes,
		checksum: await checksumOf(doc),
	};
}
