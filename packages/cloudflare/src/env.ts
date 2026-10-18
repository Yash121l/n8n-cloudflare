import type { ExecutionRunner } from './execution/execution-runner';
import type { ExecutionWorkflowParams } from './execution/execution-workflow';
import type { PushHub } from './push/push-hub';
import type { TriggerConnection } from './triggers/trigger-connection';
import type { TriggerScheduler } from './triggers/trigger-scheduler';

export interface Env {
	DB: D1Database;
	LOADER?: WorkerLoader;
	/** Execution data, binary data and other blobs. */
	STORAGE: R2Bucket;
	ASSETS: Fetcher;
	PUSH: DurableObjectNamespace<PushHub>;
	TRIGGERS: DurableObjectNamespace<TriggerScheduler>;
	/** One object per active trigger node with a persistent connection, see TriggerConnection. */
	TRIGGER_CONNECTIONS: DurableObjectNamespace<TriggerConnection>;
	RUNNER: DurableObjectNamespace<ExecutionRunner>;
	EXECUTIONS: Workflow<ExecutionWorkflowParams>;
	LOGIN_IP_LIMITER: RateLimit;
	LOGIN_EMAIL_LIMITER: RateLimit;
	PASSWORD_USER_LIMITER: RateLimit;
	/** Version of the running code. Lets long-lived Durable Objects notice a newer deploy. */
	CF_VERSION_METADATA?: WorkerVersionMetadata;

	/** Same meaning as N8N_ENCRYPTION_KEY in stock n8n. Set as a Worker secret. */
	N8N_ENCRYPTION_KEY: string;
	/** Public origin of the instance, e.g. https://n8n.example.workers.dev. Derived from the request when unset. */
	N8N_EDITOR_BASE_URL?: string;
	N8N_DEFAULT_TIMEZONE?: string;
	/** Set to `true` to turn off the login and password rate limits. Stock n8n only limits in production. */
	N8N_RATE_LIMIT_DISABLED?: string;
}
