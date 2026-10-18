/** Row shapes of migrations/0001_init.sql. Booleans are 0/1, JSON columns are TEXT. */

export interface UserRow {
	id: string;
	email: string | null;
	firstName: string | null;
	lastName: string | null;
	password: string | null;
	personalizationAnswers: string | null;
	settings: string | null;
	roleSlug: string;
	disabled: number;
	mfaEnabled: number;
	mfaSecret: string | null;
	mfaRecoveryCodes: string;
	lastActiveAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ProjectRow {
	id: string;
	name: string;
	type: 'personal' | 'team';
	icon: string | null;
	description: string | null;
	creatorId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface WorkflowRow {
	id: string;
	name: string;
	description: string | null;
	active: number;
	isArchived: number;
	nodes: string;
	connections: string;
	settings: string | null;
	staticData: string | null;
	meta: string | null;
	pinData: string | null;
	nodeGroups: string;
	versionId: string;
	activeVersionId: string | null;
	versionCounter: number;
	triggerCount: number;
	parentFolderId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CredentialRow {
	id: string;
	name: string;
	description: string | null;
	/** Encrypted with N8N_ENCRYPTION_KEY, same format as stock n8n. */
	data: string;
	type: string;
	isManaged: number;
	isGlobal: number;
	createdAt: string;
	updatedAt: string;
}

export interface ExecutionRow {
	id: number;
	workflowId: string;
	finished: number;
	mode: string;
	status: string;
	retryOf: string | null;
	retrySuccessId: string | null;
	createdAt: string;
	startedAt: string | null;
	stoppedAt: string | null;
	deletedAt: string | null;
	waitTill: string | null;
	workflowVersionId: string | null;
	instanceId: string | null;
	jsonSizeBytes: number;
}

export interface WebhookRow {
	workflowId: string;
	webhookPath: string;
	method: string;
	node: string;
	webhookId: string | null;
	pathLength: number | null;
}

export const nowIso = () => new Date().toISOString();

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (value === null || value === undefined || value === '') return fallback;
	return JSON.parse(value) as T;
}
