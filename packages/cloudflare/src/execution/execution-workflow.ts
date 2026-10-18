import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

import type { Env } from '../env';
import type { RunRequest } from './runner';
import { runExecution } from './runner';
import { executionKeys, loadExecutionData } from './store';

export interface ExecutionWorkflowParams {
	executionId: string;
}

/** Longest single sleep. Waits beyond this sleep again in a loop. */
const MAX_SLEEP_MS = 300 * 24 * 60 * 60 * 1000;

async function loadRequest(env: Env, executionId: string): Promise<RunRequest> {
	const object = await env.STORAGE.get(executionKeys(executionId).request);
	if (!object) throw new Error(`Run request of execution ${executionId} is missing`);
	return await object.json<RunRequest>();
}

/**
 * Durable runner for one execution. A run that stops at a timed Wait node sleeps here
 * and resumes from the saved state, like stock n8n's WaitTracker.
 */
export class ExecutionWorkflow extends WorkflowEntrypoint<Env, ExecutionWorkflowParams> {
	async run(event: WorkflowEvent<ExecutionWorkflowParams>, step: WorkflowStep): Promise<void> {
		const { executionId } = event.payload;
		const once = { retries: { limit: 0, delay: 0 }, timeout: '1 hour' } as const;

		let outcome = await step.do('run', once, async () => {
			const run = await runExecution(this.env, await loadRequest(this.env, executionId));
			return { status: run.status, waitTill: run.waitTill?.getTime() ?? null };
		});

		for (let segment = 1; outcome.status === 'waiting' && outcome.waitTill !== null; segment++) {
			// A waitTill far in the future means "wait for a webhook"; the webhook resumes it instead.
			if (outcome.waitTill - Date.now() > MAX_SLEEP_MS * 10) return;
			const resumeAt = Math.min(outcome.waitTill, Date.now() + MAX_SLEEP_MS);
			await step.sleepUntil(`wait-${segment}`, new Date(resumeAt));
			if (resumeAt < outcome.waitTill) continue;

			outcome = await step.do(`resume-${segment}`, once, async () => {
				const request = await loadRequest(this.env, executionId);
				const executionData = await loadExecutionData(this.env, executionId);
				if (!executionData) throw new Error(`Execution ${executionId} has no saved data`);
				// WorkflowExecute.handleWaitingState clears waitTill and skips the Wait node.
				const run = await runExecution(this.env, {
					...request,
					executionData,
					pushRef: executionData.pushRef ?? request.pushRef,
				});
				return { status: run.status, waitTill: run.waitTill?.getTime() ?? null };
			});
		}
	}
}
