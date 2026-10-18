import { addPublishEvent, setActiveVersion, setArchived } from '../db/workflows';
import type { WorkflowDoc } from '../db/workflows';
import type { UserRow } from '../db/types';
import * as runtime from '../runtime/service';
import type { RunContext } from '../runtime/service';
import { HttpError } from './errors';

export const authorOf = (user: Pick<UserRow, 'firstName' | 'lastName'>) =>
	`${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();

/** Engine errors on activation are shown to the user as a bad request, like stock n8n does. */
export function activationError(error: unknown): HttpError {
	if (error instanceof HttpError) return error;
	return new HttpError(400, error instanceof Error ? error.message : String(error));
}

/** Stops triggers and webhooks and clears the active version. Does nothing when inactive. */
export async function deactivate(
	rc: RunContext,
	user: UserRow | null,
	doc: WorkflowDoc,
): Promise<void> {
	if (doc.activeVersionId === null) return;
	await runtime.deactivateWorkflow(rc, doc.id);
	await setActiveVersion(rc.env.DB, doc.id, null);
	await addPublishEvent(rc.env.DB, {
		workflowId: doc.id,
		versionId: doc.activeVersionId,
		event: 'deactivated',
		userId: user?.id ?? null,
	});
}

/**
 * Makes `versionId` the active version and registers triggers. The runtime reads the nodes of
 * the active version from workflow_history, so the row is written first. On failure the
 * previous state is not restored: the workflow ends up inactive, as in stock n8n.
 */
export async function activate(
	rc: RunContext,
	user: UserRow,
	doc: WorkflowDoc,
	versionId: string,
): Promise<void> {
	const db = rc.env.DB;
	if (doc.activeVersionId !== null) {
		await runtime.deactivateWorkflow(rc, doc.id);
		await addPublishEvent(db, {
			workflowId: doc.id,
			versionId: doc.activeVersionId,
			event: 'deactivated',
			userId: user.id,
		});
	}
	await setActiveVersion(db, doc.id, versionId);
	try {
		await runtime.activateWorkflow(rc, doc.id);
	} catch (error) {
		try {
			await runtime.deactivateWorkflow(rc, doc.id);
		} catch (cleanupError) {
			console.error('Could not roll back a failed activation', cleanupError);
		}
		await setActiveVersion(db, doc.id, null);
		throw activationError(error);
	}
	await addPublishEvent(db, {
		workflowId: doc.id,
		versionId,
		event: 'activated',
		userId: user.id,
	});
}

/** Archives a workflow, stopping it first. Writes a history row for the new version. */
export async function archiveWorkflow(
	rc: RunContext,
	user: UserRow,
	doc: WorkflowDoc,
): Promise<string> {
	await deactivate(rc, user, doc);
	const versionId = crypto.randomUUID();
	await setArchived(rc.env.DB, doc, true, versionId, {
		versionId,
		workflowId: doc.id,
		nodes: doc.nodes,
		connections: doc.connections,
		nodeGroups: doc.nodeGroups,
		authors: authorOf(user),
		autosaved: false,
	});
	return versionId;
}

export async function unarchiveWorkflow(
	rc: RunContext,
	user: UserRow,
	doc: WorkflowDoc,
): Promise<string> {
	const versionId = crypto.randomUUID();
	await setArchived(rc.env.DB, doc, false, versionId, {
		versionId,
		workflowId: doc.id,
		nodes: doc.nodes,
		connections: doc.connections,
		nodeGroups: doc.nodeGroups,
		authors: authorOf(user),
		autosaved: false,
	});
	return versionId;
}
