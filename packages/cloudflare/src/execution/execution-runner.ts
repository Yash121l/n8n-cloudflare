import { DurableObject } from 'cloudflare:workers';
import { stringify } from 'flatted';
import type { IRun, IRunExecutionData } from 'n8n-workflow';

import type { Env } from '../env';
import type { RunOptions, RunRequest } from './runner';
import { cancellationData, executionDeadline, resumeParentData, runExecution } from './runner';
import { executeOwnedWebhookTail } from '../webhooks/execute';
import {
	executionKeys,
	getExecutionRow,
	loadExecutionData,
	saveExecutionData,
	updateExecution,
} from './store';

type Pending =
	| { kind: 'run' }
	| { kind: 'resume'; due: number }
	| { kind: 'child'; due: number; attempt?: number };

/** A waitTill this far ahead means "wait for a webhook". The webhook resumes the run instead. */
const WEBHOOK_WAIT_THRESHOLD_MS = 500 * 365 * 24 * 60 * 60 * 1000;
/** How often the watchdog checks for runs that an eviction or crash interrupted. */
const WATCHDOG_MS = 60_000;
/** A finished child notifies its parent. This check catches a notification that got lost. */
const CHILD_CHECK_MS = 60_000;
/** The check backs off up to this interval while no child of the wait has a result. */
const CHILD_CHECK_MAX_MS = 60 * 60_000;

/** Header names of the webhook handoff in `executeWebhook`. */
export const EXECUTION_ID_HEADER = 'x-n8n-execution-id';
export const CLAIMED_HEADER = 'x-n8n-claimed';

const pendingKey = (executionId: string) => `pending:${executionId}`;

const sameEntry = (a: Pending | undefined, b: Pending) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Runs the executions of one workflow. Keeping one object for each workflow keeps its isolate
 * warm with the node types already loaded, so a run starts in milliseconds. Timed Wait nodes
 * resume from an alarm, like stock n8n's WaitTracker.
 */
export class ExecutionRunner extends DurableObject<Env> {
	/** Accepted runs. The value is the cancel handle of the engine once it starts. */
	private readonly running = new Map<string, { cancel(reason?: string): void } | undefined>();
	/** Stops that arrive before the engine hands back its cancel handle. */
	private readonly canceled = new Set<string>();
	private readonly accepting = new Set<string>();
	/** Calls that arrived and are not yet registered in `accepting` or `running`. */
	private entering = 0;

	/**
	 * A runner can outlive a deploy and keep running old code. When the caller runs newer code and
	 * nothing is in flight here, reset the object so the retried call runs the new code.
	 */
	async ensureVersion(callerTimestamp: string | undefined): Promise<void> {
		const own = this.env.CF_VERSION_METADATA?.timestamp;
		if (!callerTimestamp || !own || !(Date.parse(own) < Date.parse(callerTimestamp))) return;
		if (this.busy()) return;
		// A pending run is accepted work. The watchdog ends it if it was interrupted.
		const pending = await this.ctx.storage.list<Pending>({ prefix: 'pending:' });
		if ([...pending.values()].some((entry) => entry.kind === 'run') || this.busy()) return;
		this.ctx.abort('A newer version of the code is deployed');
	}

	private busy(): boolean {
		return this.entering > 0 || this.accepting.size > 0 || this.running.size > 0;
	}

	/** `request` travels with the call, so the run starts without a storage round trip. */
	async start(executionId: string, request: RunRequest): Promise<void> {
		if (!(await this.accept(executionId, request))) return;
		this.ctx.waitUntil(this.execute(executionId, { kind: 'run' }, request));
	}

	/** Runs a sub-workflow and returns its flatted IRun to the parent. */
	async startAndWait(executionId: string, request: RunRequest): Promise<string> {
		if (!(await this.accept(executionId, request)))
			throw new Error(`Execution ${executionId} was already accepted`);
		const execution = this.execute(executionId, { kind: 'run' }, request);
		this.ctx.waitUntil(execution);
		const run = await execution;
		if (!run) throw new Error(`Execution ${executionId} did not produce a result`);
		return stringify(run);
	}

	/**
	 * Webhook runs. The HTTP request comes here, so Respond to Webhook can answer while later
	 * nodes still run, and a stop reaches the engine.
	 */
	async fetch(httpRequest: Request): Promise<Response> {
		const executionId = httpRequest.headers.get(EXECUTION_ID_HEADER);
		if (!executionId) return new Response('Missing execution ID', { status: 400 });
		this.entering++;
		let accepted = false;
		let request: RunRequest;
		try {
			request = await this.loadRequest(executionId);
			const claimed = httpRequest.headers.get(CLAIMED_HEADER) === '1';
			accepted = await this.accept(executionId, request, claimed);
		} finally {
			this.entering--;
		}
		if (!accepted) return new Response('Execution already accepted', { status: 409 });
		let started = false;
		try {
			return await executeOwnedWebhookTail(
				{ env: this.env, ctx: this.ctx, baseUrl: request.baseUrl },
				request,
				httpRequest,
				async (options) => {
					started = true;
					return await this.execute(executionId, { kind: 'run' }, request, options);
				},
			);
		} finally {
			if (!started) {
				// The pending run stays, so the watchdog marks the run as crashed.
				this.release(executionId);
				await this.scheduleAlarm();
			}
		}
	}

	/**
	 * Durable acceptance: after this returns true, the run is recorded in storage and a crash
	 * marks it as crashed instead of losing it. `claimed` is true when the caller already moved
	 * a waiting execution to running, as a webhook resume does.
	 */
	private async accept(
		executionId: string,
		request: RunRequest,
		claimed = false,
	): Promise<boolean> {
		if (this.accepting.has(executionId) || this.running.has(executionId)) return false;
		this.accepting.add(executionId);
		let accepted = false;
		try {
			const pending = await this.ctx.storage.get<Pending>(pendingKey(executionId));
			if (pending && (pending.kind === 'run' || !claimed)) return false;
			const row = await getExecutionRow(this.env, executionId);
			if (row?.status !== (claimed ? 'running' : 'new')) return false;
			request.executionTimeoutTimestamp ??= executionDeadline(this.env, request.workflowData);
			const instanceId = `runner:${request.workflowData.id ?? executionId}`;
			if (row.instanceId !== instanceId) {
				await updateExecution(this.env, executionId, { instanceId }, { requireNotCanceled: true });
			}
			await this.ctx.storage.put<Pending>(pendingKey(executionId), { kind: 'run' });
			// Registered before the caller continues, so a stop, the watchdog and a version reset see it.
			this.running.set(executionId, undefined);
			accepted = true;
			return true;
		} finally {
			this.accepting.delete(executionId);
			if (!accepted) this.canceled.delete(executionId);
		}
	}

	private release(executionId: string): void {
		this.running.delete(executionId);
		this.canceled.delete(executionId);
	}

	async cancel(executionId: string): Promise<void> {
		await this.ctx.storage.delete(pendingKey(executionId));
		const execution = this.running.get(executionId);
		if (execution) execution.cancel('Execution was stopped');
		else if (this.running.has(executionId) || this.accepting.has(executionId))
			this.canceled.add(executionId);
		await this.scheduleAlarm();
	}

	/** A child of this waiting parent finished. Port of WaitTracker.resumeParentExecution. */
	async childFinished(parentExecutionId: string): Promise<void> {
		const pending = await this.ctx.storage.get<Pending>(pendingKey(parentExecutionId));
		if (pending?.kind !== 'child' || this.running.has(parentExecutionId)) return;
		this.ctx.waitUntil(this.execute(parentExecutionId, pending));
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		const pending = await this.ctx.storage.list<Pending>({ prefix: 'pending:' });
		for (const [key, entry] of pending) {
			const executionId = key.slice('pending:'.length);
			if (this.running.has(executionId) || this.accepting.has(executionId)) continue;
			if (entry.kind !== 'run') {
				if (entry.due <= now) this.ctx.waitUntil(this.execute(executionId, entry));
				continue;
			}
			// A run that is pending but not in memory was interrupted. Never run it twice.
			await this.ctx.storage.delete(key);
			await updateExecution(
				this.env,
				executionId,
				{ status: 'crashed', stoppedAt: new Date().toISOString() },
				{ requireNotCanceled: true },
			);
		}
		await this.scheduleAlarm();
	}

	/** Deletes the pending entry only if no other path replaced it since `entry` was read. */
	private async deletePendingIf(executionId: string, entry: Pending): Promise<void> {
		const current = await this.ctx.storage.get<Pending>(pendingKey(executionId));
		if (sameEntry(current, entry)) await this.ctx.storage.delete(pendingKey(executionId));
	}

	/** Moves a timed wait to running. Only the claim winner resumes it. */
	private async claimTimedResume(executionId: string, entry: Pending & { kind: 'resume' }) {
		// A webhook or another alarm may have resumed this wait already.
		const claimed = await this.env.DB.prepare(
			"UPDATE execution_entity SET status = 'running' WHERE id = ? AND status = 'waiting' AND waitTill = ? RETURNING id",
		)
			.bind(Number(executionId), new Date(entry.due).toISOString())
			.first();
		if (!claimed) {
			await this.deletePendingIf(executionId, entry);
			return false;
		}
		// The resumed run is accepted work now: the watchdog covers it, and the past due time stops firing.
		await this.ctx.storage.put<Pending>(pendingKey(executionId), { kind: 'run' });
		return true;
	}

	private async execute(
		executionId: string,
		pending: Pending,
		startRequest?: RunRequest,
		options: RunOptions = {},
	): Promise<IRun | undefined> {
		// A timed resume registers only after its claim, so a webhook that won the claim is not refused.
		if (pending.kind === 'resume') {
			if (this.running.has(executionId) || this.accepting.has(executionId)) return;
			this.accepting.add(executionId);
			try {
				if (!(await this.claimTimedResume(executionId, pending))) return;
			} finally {
				this.accepting.delete(executionId);
			}
		}
		this.running.set(executionId, undefined);
		// A resume reads the request and snapshot back from R2. Writing them runs next to the execution.
		const persisted = startRequest
			? this.persistRequest(executionId, startRequest)
			: Promise.resolve(true);
		void this.scheduleAlarm();
		let parentExecution = startRequest?.executionData?.parentExecution;
		try {
			let request = startRequest ?? (await this.loadRequest(executionId));
			if (pending.kind === 'child') {
				const row = await getExecutionRow(this.env, executionId);
				if (row?.status !== 'waiting') {
					await this.deletePendingIf(executionId, pending);
					return;
				}
				const executionData = await resumeParentData(this.env, executionId);
				if (!executionData) {
					const attempt = (pending.attempt ?? 0) + 1;
					await this.ctx.storage.put<Pending>(pendingKey(executionId), {
						kind: 'child',
						due: Date.now() + Math.min(CHILD_CHECK_MS * 2 ** (attempt - 1), CHILD_CHECK_MAX_MS),
						attempt,
					});
					return;
				}
				// A webhook or another child may have resumed this parent already. Only the claim winner runs.
				const claimed = await this.env.DB.prepare(
					"UPDATE execution_entity SET status = 'running' WHERE id = ? AND status = 'waiting' AND waitTill IS ? RETURNING id",
				)
					.bind(Number(executionId), row.waitTill)
					.first();
				if (!claimed) return;
				await this.ctx.storage.put<Pending>(pendingKey(executionId), { kind: 'run' });
				request = { ...request, executionData, pushRef: executionData.pushRef ?? request.pushRef };
			}
			if (pending.kind === 'resume') {
				const executionData = await loadExecutionData(this.env, executionId);
				if (!executionData) throw new Error(`Execution ${executionId} has no saved data`);
				request = { ...request, executionData, pushRef: executionData.pushRef ?? request.pushRef };
			}
			parentExecution = request.executionData?.parentExecution;

			const run = await runExecution(this.env, request, {
				...options,
				onStart: (execution) => {
					options.onStart?.(execution);
					this.running.set(executionId, execution);
					if (this.canceled.delete(executionId)) execution.cancel('Execution was stopped');
				},
			});

			const waitTill = run.status === 'waiting' ? run.waitTill?.getTime() : undefined;
			// A resume needs the request. A finished run does not, so a failed write must not fail it.
			if (!(await persisted) && waitTill !== undefined && startRequest)
				await this.persistRequest(executionId, startRequest, true);
			if (
				run.status === 'waiting' &&
				run.data.executionData?.nodeExecutionStack[0]?.metadata?.waitingChildExecutionIds?.length
			) {
				// A child can finish before this entry exists, so the first check runs at once.
				await this.ctx.storage.put<Pending>(pendingKey(executionId), {
					kind: 'child',
					due: Date.now(),
				});
			} else if (waitTill !== undefined && waitTill - Date.now() < WEBHOOK_WAIT_THRESHOLD_MS) {
				await this.ctx.storage.put<Pending>(pendingKey(executionId), {
					kind: 'resume',
					due: waitTill,
				});
			} else {
				await this.ctx.storage.delete(pendingKey(executionId));
			}
			if (run.status !== 'waiting') await notifyParent(this.env, run.data.parentExecution);
			return run;
		} catch (error) {
			await persisted;
			console.error(`Execution ${executionId} failed to run`, error);
			await this.ctx.storage.delete(pendingKey(executionId));
			await updateExecution(
				this.env,
				executionId,
				{ status: 'crashed', stoppedAt: new Date().toISOString() },
				{ requireNotCanceled: true },
			);
			await notifyParent(this.env, parentExecution);
		} finally {
			this.release(executionId);
			await this.scheduleAlarm();
		}
	}

	/** Writes the request and workflow snapshot. Returns false when a write failed and `rethrow` is not set. */
	private async persistRequest(
		executionId: string,
		request: RunRequest,
		rethrow = false,
	): Promise<boolean> {
		try {
			await Promise.all([
				this.env.STORAGE.put(executionKeys(executionId).request, JSON.stringify(request)),
				this.env.STORAGE.put(
					executionKeys(executionId).workflow,
					JSON.stringify(request.workflowData),
				),
			]);
			return true;
		} catch (error) {
			if (rethrow) throw error;
			console.error(`Could not save the run request of execution ${executionId}`, error);
			return false;
		}
	}

	private async loadRequest(executionId: string): Promise<RunRequest> {
		const object = await this.env.STORAGE.get(executionKeys(executionId).request);
		if (!object) throw new Error(`Run request of execution ${executionId} is missing`);
		return await object.json<RunRequest>();
	}

	/** Next alarm: the earliest timed resume, or the watchdog while runs are in progress. */
	private async scheduleAlarm(): Promise<void> {
		const pending = await this.ctx.storage.list<Pending>({ prefix: 'pending:' });
		let next = Number.POSITIVE_INFINITY;
		for (const entry of pending.values()) {
			next = Math.min(next, entry.kind === 'run' ? Date.now() + WATCHDOG_MS : entry.due);
		}
		if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
		else await this.ctx.storage.deleteAlarm();
	}
}

/** A parent that waits for this run resumes now. A parent that does not wait ignores the call. */
export async function notifyParent(
	env: Env,
	parent: IRunExecutionData['parentExecution'],
): Promise<void> {
	if (!parent || parent.shouldResume === false) return;
	try {
		await runnerFor(env, parent.workflowId || parent.executionId).childFinished(parent.executionId);
	} catch (error) {
		console.error(`Could not notify parent execution ${parent.executionId}`, error);
	}
}

/**
 * A stopped wait never reaches the engine again. Port of stock stopDuringRun: record the
 * cancellation error in the execution data, then let a waiting parent resume with that error.
 */
export async function recordStoppedWait(env: Env, executionId: string): Promise<void> {
	const data = cancellationData(executionId, await loadExecutionData(env, executionId));
	await saveExecutionData(env, executionId, data);
	await notifyParent(env, data.parentExecution);
}

/** One runner for each workflow, so repeated runs reuse a warm isolate. */
type RunnerStub = DurableObjectStub<ExecutionRunner>;

/** One runner for each workflow, so repeated runs reuse a warm isolate. Every call first checks the code version. */
export function runnerFor(env: Env, workflowId: string): RunnerStub {
	const id = env.RUNNER.idFromName(workflowId);
	const callerTimestamp = env.CF_VERSION_METADATA?.timestamp;
	let stub = env.RUNNER.get(id);
	if (!callerTimestamp) return stub;

	const ensureFresh = async () => {
		try {
			await stub.ensureVersion(callerTimestamp);
		} catch {
			// The old object reset itself. A new stub reaches the fresh instance.
			stub = env.RUNNER.get(id);
		}
	};
	type Callable = Record<string | symbol, (...args: unknown[]) => Promise<unknown>>;
	return new Proxy(stub, {
		get(_target, prop) {
			// RPC stubs answer every property name, so only plain method names are wrapped.
			if (typeof prop !== 'string' || prop === 'then' || prop === 'ensureVersion')
				return Reflect.get(stub, prop);
			return async (...args: unknown[]) => {
				await ensureFresh();
				return await (stub as unknown as Callable)[prop](...args);
			};
		},
	});
}
