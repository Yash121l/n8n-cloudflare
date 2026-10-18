import type { Env } from '../env';

/** Execution variables of stock n8n (ExecutionsConfig). Set them as Worker vars. Unset means the stock default. */
export interface ExecutionVars {
	EXECUTIONS_TIMEOUT?: string;
	EXECUTIONS_TIMEOUT_MAX?: string;
	EXECUTIONS_DATA_SAVE_ON_SUCCESS?: string;
	EXECUTIONS_DATA_SAVE_ON_ERROR?: string;
	EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS?: string;
	EXECUTIONS_DATA_SAVE_ON_PROGRESS?: string;
	EXECUTIONS_DATA_PRUNE?: string;
	EXECUTIONS_DATA_MAX_AGE?: string;
	EXECUTIONS_DATA_PRUNE_MAX_COUNT?: string;
	EXECUTIONS_DATA_HARD_DELETE_BUFFER?: string;
}

function numberVar(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return value === undefined || value === '' || Number.isNaN(parsed) ? fallback : parsed;
}

export function executionsConfig(env: Env & ExecutionVars) {
	return {
		/** Seconds. 0 or less means no timeout. */
		timeout: numberVar(env.EXECUTIONS_TIMEOUT, -1),
		maxTimeout: numberVar(env.EXECUTIONS_TIMEOUT_MAX, 3600),
		saveDataOnSuccess: env.EXECUTIONS_DATA_SAVE_ON_SUCCESS === 'none' ? 'none' : 'all',
		saveDataOnError: env.EXECUTIONS_DATA_SAVE_ON_ERROR === 'none' ? 'none' : 'all',
		saveDataManualExecutions: env.EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS !== 'false',
		saveExecutionProgress: env.EXECUTIONS_DATA_SAVE_ON_PROGRESS === 'true',
		pruneData: env.EXECUTIONS_DATA_PRUNE !== 'false',
		/** Hours */
		pruneDataMaxAge: numberVar(env.EXECUTIONS_DATA_MAX_AGE, 336),
		pruneDataMaxCount: numberVar(env.EXECUTIONS_DATA_PRUNE_MAX_COUNT, 10_000),
		/** Hours */
		pruneDataHardDeleteBuffer: numberVar(env.EXECUTIONS_DATA_HARD_DELETE_BUFFER, 1),
	} as const;
}
