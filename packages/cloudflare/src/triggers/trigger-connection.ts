import { DurableObject } from 'cloudflare:workers';
import { TriggerContext } from 'n8n-core';
import type {
	ExecutionError,
	IExecuteResponsePromiseData,
	INode,
	INodeExecutionData,
	IRun,
	ITriggerResponse,
	IWorkflowBase,
	Workflow,
	WorkflowActivateMode,
} from 'n8n-workflow';
import { WorkflowActivationError } from 'n8n-workflow';

import type { Env } from '../env';

type IDeferredPromise<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
};
import { buildAdditionalData, executeErrorWorkflow, toExecutionError } from '../execution/runner';
import { getExecutionRow, loadExecutionData } from '../execution/store';
import { bootstrap } from '../runtime/bootstrap';
import { nodeTypes } from '../runtime/node-types';
import type { RunContext } from '../runtime/service';
import { loadActiveWorkflow, saveStaticData, toWorkflow } from '../webhooks/workflow';
import { emitExecution, recordTriggerFailure } from './schedules';

/** What the object keeps in storage, so it can connect again after an eviction or a deploy. */
interface Configuration {
	workflowId: string;
	nodeName: string;
	/** Version of the workflow that was active when the trigger started. */
	versionId: string | null;
	baseUrl: string;
	/** Changes on every start, so callbacks of an old connection can tell that they are stale. */
	generation: string;
	/** Failed connection attempts in a row. Sets the reconnect delay. */
	failures: number;
}

interface Connection {
	generation: string;
	workflowData: IWorkflowBase;
	workflow: Workflow;
	node: INode;
	baseUrl: string;
	close?: () => Promise<void>;
}

export interface ConnectionState {
	configured: boolean;
	connected: boolean;
	nodeName?: string;
	failures: number;
	alarm: number | null;
	emitted: number;
	lastError?: string;
}

/** The watchdog alarm interval. Each alarm also keeps the object in memory, so its sockets stay open. */
export const WATCHDOG_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 5 * 60_000;
const TERMINAL_STATUSES = new Set(['success', 'error', 'canceled', 'crashed']);
/**
 * These triggers emit once for a workflow or instance event and keep no connection. When the
 * object starts again after an eviction, running them again would emit a false event.
 */
const EVENT_ONLY_TYPES = new Set(['n8n-nodes-base.n8nTrigger', 'n8n-nodes-base.workflowTrigger']);

export const connectionName = (workflowId: string, nodeName: string) =>
	`${workflowId}\n${nodeName}`;

export function triggerConnection(env: Env, workflowId: string, nodeName: string) {
	return env.TRIGGER_CONNECTIONS.get(
		env.TRIGGER_CONNECTIONS.idFromName(connectionName(workflowId, nodeName)),
	);
}

/**
 * The items go to the ExecutionRunner over RPC, which clones only plain data. Socket clients emit
 * class instances, like a pg Notification, so the JSON of each item is made plain first.
 */
function plainItems(data: INodeExecutionData[][]): INodeExecutionData[][] {
	return data.map((output) =>
		output.map((item) => ({ ...item, json: JSON.parse(JSON.stringify(item.json ?? {})) })),
	);
}

function reconnectDelay(failures: number): number {
	return Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.max(0, failures - 1));
}

/**
 * One instance per active (workflow, trigger node) pair. It calls the stock node's `trigger()`
 * with `mode = 'trigger'` and keeps the connection that the node opens. Port of the
 * persistent part of ActiveWorkflowManager and TriggerExecutionContextFactory
 * (packages/cli/src/active-workflow-manager.ts, workflows/triggers/trigger-execution-context.factory.ts).
 *
 * A watchdog alarm runs every WATCHDOG_MS. It stops the trigger when the workflow is no longer
 * active in that version, and it connects again when the object lost its connection, for
 * example after an eviction, a deploy, or an `emitError` from the node.
 */
export class TriggerConnection extends DurableObject<Env> {
	private connection?: Connection;
	/** Serializes start, stop and the alarm, which can otherwise interleave at each await. */
	private queue: Promise<unknown> = Promise.resolve();
	private emitted = 0;
	private lastError?: string;
	private readonly pending = new Set<Promise<unknown>>();

	private serialized<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => {});
		return next;
	}

	/** Starts the trigger. Errors of the node, like a refused connection, fail the activation. */
	async start(workflowId: string, nodeName: string, baseUrl: string): Promise<void> {
		await bootstrap(this.env);
		await this.serialized(async () => {
			await this.disconnect();
			const configuration: Configuration = {
				workflowId,
				nodeName,
				versionId: null,
				baseUrl,
				generation: crypto.randomUUID(),
				failures: 0,
			};
			try {
				configuration.versionId = await this.openTrigger(configuration, 'activate');
			} catch (error) {
				await this.ctx.storage.deleteAll();
				await this.ctx.storage.deleteAlarm();
				throw error;
			}
			await this.ctx.storage.put('configuration', configuration);
			await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
		});
	}

	/** Runs the node's closeFunction and forgets the trigger. */
	async stop(): Promise<void> {
		await bootstrap(this.env);
		await this.serialized(async () => {
			await this.ctx.storage.deleteAlarm();
			await this.ctx.storage.deleteAll();
			await this.disconnect();
		});
	}

	async inspect(): Promise<ConnectionState> {
		const configuration = await this.ctx.storage.get<Configuration>('configuration');
		return {
			configured: Boolean(configuration),
			connected: Boolean(this.connection),
			nodeName: configuration?.nodeName,
			failures: configuration?.failures ?? 0,
			alarm: await this.ctx.storage.getAlarm(),
			emitted: this.emitted,
			lastError: this.lastError,
		};
	}

	async alarm(): Promise<void> {
		await bootstrap(this.env);
		await this.serialized(async () => {
			const configuration = await this.ctx.storage.get<Configuration>('configuration');
			if (!configuration) return;
			if (!(await this.isStillActive(configuration))) {
				await this.ctx.storage.deleteAll();
				await this.disconnect();
				return;
			}
			if (!this.connection) {
				const node = (await loadActiveWorkflow(this.env, configuration.workflowId)).nodes.find(
					(candidate) => candidate.name === configuration.nodeName,
				);
				if (node && EVENT_ONLY_TYPES.has(node.type)) {
					await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
					return;
				}
				const next = { ...configuration, generation: crypto.randomUUID() };
				try {
					await this.openTrigger(next, 'init');
					next.failures = 0;
				} catch (error) {
					next.failures++;
					this.lastError = error instanceof Error ? error.message : String(error);
					console.error(
						`The trigger "${configuration.nodeName}" of workflow ${configuration.workflowId} could not connect`,
						error,
					);
					await this.ctx.storage.put('configuration', next);
					await this.ctx.storage.setAlarm(Date.now() + reconnectDelay(next.failures));
					return;
				}
				await this.ctx.storage.put('configuration', next);
			}
			await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
		});
	}

	/** False when the workflow was deactivated, or a different version or node set is active now. */
	private async isStillActive(configuration: Configuration): Promise<boolean> {
		const row = await this.env.DB.prepare(
			'SELECT active, activeVersionId, versionId FROM workflow_entity WHERE id = ?',
		)
			.bind(configuration.workflowId)
			.first<{ active: number; activeVersionId: string | null; versionId: string }>();
		if (!row?.active) return false;
		return (row.activeVersionId ?? row.versionId) === configuration.versionId;
	}

	private runContext(baseUrl: string): RunContext {
		return { env: this.env, ctx: this.ctx, baseUrl };
	}

	/** Calls the node's trigger() and keeps what it returns. Returns the version it started. */
	private async openTrigger(
		configuration: Configuration,
		activation: WorkflowActivateMode,
	): Promise<string | null> {
		const { workflowId, nodeName, baseUrl, generation } = configuration;
		const workflowData = await loadActiveWorkflow(this.env, workflowId);
		const workflow = await toWorkflow(workflowData);
		const node = workflow.getNode(nodeName);
		if (!node) throw new WorkflowActivationError(`The trigger node "${nodeName}" does not exist`);
		const type = nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
		if (!type.trigger) throw new WorkflowActivationError(`The node "${nodeName}" is not a trigger`);
		const additionalData = await buildAdditionalData(this.env, { baseUrl, workflowId });
		const context = new TriggerContext(
			workflow,
			node,
			additionalData,
			'trigger',
			activation,
			(data, responsePromise, donePromise) =>
				this.emit(generation, data, responsePromise, donePromise),
			(error) => this.onTriggerError(generation, error),
			(error) => this.saveFailedExecution(generation, error),
		);
		const connection: Connection = { generation, workflowData, workflow, node, baseUrl };
		// Emits that arrive while trigger() still runs must find the connection.
		this.connection = connection;
		let response: ITriggerResponse | undefined;
		try {
			response = await type.trigger.call(context);
		} catch (error) {
			if (this.connection === connection) this.connection = undefined;
			throw error;
		}
		connection.close = response?.closeFunction;
		// A stop() or an error during trigger() replaced this connection. Close what the node opened.
		if (this.connection !== connection) {
			await this.closeQuietly(connection);
			throw new WorkflowActivationError(`The trigger node "${nodeName}" stopped while it started`);
		}
		this.lastError = undefined;
		return workflowData.versionId ?? null;
	}

	private async disconnect(): Promise<void> {
		const connection = this.connection;
		this.connection = undefined;
		if (connection) await this.closeQuietly(connection);
	}

	private async closeQuietly(connection: Connection): Promise<void> {
		try {
			await connection.close?.();
		} catch (error) {
			console.error(`Could not close the trigger "${connection.node.name}"`, error);
		}
	}

	private current(generation: string): Connection | undefined {
		return this.connection?.generation === generation ? this.connection : undefined;
	}

	/** Port of the `emit` of TriggerExecutionContextFactory.getExecuteTriggerFunctions. */
	private emit(
		generation: string,
		data: INodeExecutionData[][],
		responsePromise?: IDeferredPromise<IExecuteResponsePromiseData>,
		donePromise?: IDeferredPromise<IRun>,
	): void {
		const connection = this.current(generation);
		if (!connection) {
			responsePromise?.reject(new Error('The trigger was stopped'));
			donePromise?.reject(new Error('The trigger was stopped'));
			return;
		}
		const { workflow, node, baseUrl } = connection;
		const task = (async () => {
			await saveStaticData(this.env, workflow);
			// JSON drops the observable proxy around static data.
			const workflowData: IWorkflowBase = JSON.parse(
				JSON.stringify({ ...connection.workflowData, staticData: workflow.staticData }),
			);
			const executionId = await emitExecution(
				this.runContext(baseUrl),
				workflowData,
				node,
				plainItems(data),
			);
			this.emitted++;
			if (!responsePromise && !donePromise) return;
			const run = executionId ? await this.waitForRun(executionId) : undefined;
			// Like the engine at teardown, an empty response tells the node that no node sent one.
			responsePromise?.resolve({});
			// Stock resolves with undefined when no execution started. The node type omits that case.
			donePromise?.resolve(run as IRun);
		})().catch((error: unknown) => {
			console.error(
				`The trigger "${node.name}" of workflow ${workflow.id} could not start an execution`,
				error,
			);
			const failure = error instanceof Error ? error : new Error(String(error));
			responsePromise?.reject(failure);
			donePromise?.reject(failure);
		});
		this.track(task);
	}

	private track(task: Promise<unknown>): void {
		this.pending.add(task);
		void task.finally(() => this.pending.delete(task));
	}

	/** The run as the node's donePromise expects it. Port of ActiveExecutions.getPostExecutePromise. */
	private async waitForRun(executionId: string): Promise<IRun | undefined> {
		let delay = 200;
		for (;;) {
			const row = await getExecutionRow(this.env, executionId);
			if (!row) return undefined;
			if (TERMINAL_STATUSES.has(row.status)) {
				const data = await loadExecutionData(this.env, executionId);
				return {
					data: data ?? { resultData: { runData: {} } },
					mode: 'trigger',
					status: row.status,
					finished: Boolean(row.finished),
					startedAt: new Date(row.startedAt ?? row.createdAt),
					stoppedAt: row.stoppedAt ? new Date(row.stoppedAt) : new Date(),
				} as IRun;
			}
			await new Promise((resolve) => setTimeout(resolve, delay));
			delay = Math.min(delay * 1.5, 5000);
		}
	}

	/**
	 * Port of the stock `emitError` handler: the trigger is removed, the error workflow runs, and
	 * the activation is queued again with a backoff. Here the alarm connects again.
	 */
	private onTriggerError(generation: string, error: Error): void {
		const connection = this.current(generation);
		if (!connection) return;
		this.connection = undefined;
		this.lastError = error.message;
		console.error(
			`The trigger node "${connection.node.name}" of workflow "${connection.workflowData.name}" failed. It will connect again.`,
			error,
		);
		const task = this.serialized(async () => {
			await this.closeQuietly(connection);
			const configuration = await this.ctx.storage.get<Configuration>('configuration');
			if (!configuration || configuration.generation !== generation) return;
			const next = { ...configuration, failures: configuration.failures + 1 };
			await this.ctx.storage.put('configuration', next);
			await this.ctx.storage.setAlarm(Date.now() + reconnectDelay(next.failures));
			const activationError = new WorkflowActivationError(
				`The workflow was deactivated because its trigger node "${connection.node.name}" failed`,
				{ cause: error, node: connection.node },
			);
			await executeErrorWorkflow(this.env, {
				workflowData: connection.workflowData,
				baseUrl: connection.baseUrl,
				mode: 'trigger',
				error: toExecutionError(activationError),
				lastNodeExecuted: connection.node.name,
			});
		}).catch((cause: unknown) => console.error('Could not handle a trigger error', cause));
		this.track(task);
	}

	/** Port of the stock `saveFailedExecution`: a failed execution, then the error workflow. */
	private saveFailedExecution(generation: string, error: ExecutionError): void {
		const connection = this.current(generation);
		if (!connection) return;
		const task = (async () => {
			await recordTriggerFailure(
				this.runContext(connection.baseUrl),
				connection.workflowData,
				connection.node,
				error,
				`connection:${generation}:${crypto.randomUUID()}`,
			);
		})().catch((cause: unknown) => console.error('Could not record a trigger failure', cause));
		this.track(task);
	}
}
