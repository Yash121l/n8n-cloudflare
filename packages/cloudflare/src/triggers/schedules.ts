import { PollContext, TriggerContext } from 'n8n-core';
import { CronTime } from 'cron';
import type {
	Cron,
	ExecutionError,
	INode,
	INodeExecutionData,
	IWorkflowBase,
	TriggerTime,
	Workflow,
} from 'n8n-workflow';
import {
	createErrorExecutionData,
	createRunExecutionData,
	isSubMinuteCron,
	toCronExpression,
	WorkflowActivationError,
} from 'n8n-workflow';

import { buildAdditionalData, executeErrorWorkflow } from '../execution/runner';
import {
	createExecution,
	getExecutionRow,
	saveExecutionData,
	updateExecution,
} from '../execution/store';
import { nodeTypes } from '../runtime/node-types';
import type { RunContext } from '../runtime/service';
import { projectIdOfWorkflow, startDurableExecution } from '../runtime/service';
import { saveStaticData } from '../webhooks/workflow';

export interface Schedule {
	node: string;
	kind: 'cron' | 'poll';
	index: number;
	expression: string;
	timezone: string;
}

export interface RegisteredSchedule extends Schedule {
	callback: (scheduledAt: Date) => void;
}

const scheduledTypes = new Set(['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.cron']);
/** Triggers that never listen. Other workflows, the editor or the error handler start them. */
const manualTypes = new Set([
	'n8n-nodes-base.manualTrigger',
	'n8n-nodes-base.start',
	'n8n-nodes-base.executeWorkflowTrigger',
	'n8n-nodes-base.errorTrigger',
]);

/**
 * Trigger nodes that keep a connection open, such as IMAP, MQTT, AMQP and Kafka triggers. Each
 * runs in its own TriggerConnection Durable Object. Schedule triggers run from TriggerScheduler alarms.
 */
export function persistentTriggerNodes(workflow: Workflow): INode[] {
	return Object.values(workflow.nodes).filter((node) => {
		if (node.disabled || manualTypes.has(node.type) || scheduledTypes.has(node.type)) return false;
		return Boolean(nodeTypes.getByNameAndVersion(node.type, node.typeVersion).trigger);
	});
}

/** Throws when the workflow uses a node type that this runtime cannot load. */
export function validateTriggerTypes(workflow: Workflow): void {
	for (const node of Object.values(workflow.nodes)) {
		if (node.disabled || manualTypes.has(node.type)) continue;
		nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
	}
}

export async function registerSchedules(
	rc: RunContext,
	workflow: Workflow,
	emit: (node: INode, data: INodeExecutionData[][]) => void,
): Promise<RegisteredSchedule[]> {
	validateTriggerTypes(workflow);
	const additionalData = await buildAdditionalData(rc.env, {
		baseUrl: rc.baseUrl,
		workflowId: workflow.id,
	});
	const schedules: RegisteredSchedule[] = [];
	for (const node of Object.values(workflow.nodes)) {
		if (node.disabled || manualTypes.has(node.type)) continue;
		const type = nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
		if (type.trigger) {
			// Triggers with persistent connections run in TriggerConnection, not here.
			if (!scheduledTypes.has(node.type)) continue;
			let index = 0;
			const context = new TriggerContext(
				workflow,
				node,
				additionalData,
				'trigger',
				'activate',
				(data) => emit(node, data),
				(error) => {
					throw error;
				},
				(error) => {
					throw error;
				},
				{
					registerCron: (cron: Cron, callback) => {
						new CronTime(cron.expression, workflow.timezone);
						schedules.push({
							node: node.name,
							kind: 'cron',
							index: index++,
							expression: cron.expression,
							timezone: workflow.timezone,
							callback,
						});
					},
				},
			);
			await type.trigger.call(context);
		} else if (type.poll) {
			const context = new PollContext(workflow, node, additionalData, 'trigger', 'activate');
			const times = context.getNodeParameter('pollTimes', { item: [{ mode: 'everyMinute' }] }) as {
				item: TriggerTime[];
			};
			for (const [index, time] of times.item.entries()) {
				const expression = toCronExpression(time);
				new CronTime(expression, workflow.timezone);
				if (isSubMinuteCron(expression))
					throw new WorkflowActivationError(
						'The polling interval is too short. It has to be at least a minute.',
						{ node },
					);
				schedules.push({
					node: node.name,
					kind: 'poll',
					index,
					expression,
					timezone: workflow.timezone,
					callback: () => {},
				});
			}
		}
	}
	return schedules;
}

export async function emitExecution(
	rc: RunContext,
	workflowData: IWorkflowBase,
	node: INode,
	data: INodeExecutionData[][],
	occurrenceKey?: string,
): Promise<string | undefined> {
	if (!data.some((output) => output.length)) return undefined;
	const executionId = await createExecution(rc.env, {
		workflowData,
		mode: 'trigger',
		occurrenceKey,
	});
	await startDurableExecution(rc, {
		executionId,
		executionMode: 'trigger',
		workflowData,
		baseUrl: rc.baseUrl,
		projectId: workflowData.id ? await projectIdOfWorkflow(rc.env, workflowData.id) : undefined,
		executionData: createRunExecutionData({
			executionData: { nodeExecutionStack: [{ node, data: { main: data }, source: null }] },
		}),
	});
	return executionId;
}

/**
 * Port of recordTriggerFailure (packages/cli/src/workflows/triggers/trigger-execution-context.factory.ts)
 * and ExecutionService.createErrorExecution: save a failed execution, then run the error workflow.
 * The occurrence key makes a retried handoff record the failure once.
 */
export async function recordTriggerFailure(
	rc: RunContext,
	workflowData: IWorkflowBase,
	node: INode,
	error: ExecutionError,
	occurrenceKey: string,
): Promise<void> {
	if (workflowData.settings?.saveDataErrorExecution !== 'none') {
		const executionId = await createExecution(rc.env, {
			workflowData,
			mode: 'trigger',
			status: 'error',
			occurrenceKey,
		});
		const row = await getExecutionRow(rc.env, executionId);
		// A retried handoff finds the failure recorded already.
		if (row?.stoppedAt) return;
		const size = await saveExecutionData(
			rc.env,
			executionId,
			createErrorExecutionData(node, error),
		);
		await updateExecution(rc.env, executionId, {
			stoppedAt: new Date().toISOString(),
			jsonSizeBytes: size,
		});
	}
	await executeErrorWorkflow(rc.env, {
		workflowData,
		baseUrl: rc.baseUrl,
		mode: 'trigger',
		error,
		lastNodeExecuted: node.name,
	});
}

export async function runPoll(
	rc: RunContext,
	workflow: Workflow,
	node: INode,
	onEmit: (data: INodeExecutionData[][]) => void = () => {},
): Promise<INodeExecutionData[][] | null> {
	const additionalData = await buildAdditionalData(rc.env, {
		baseUrl: rc.baseUrl,
		workflowId: workflow.id,
	});
	const context = new PollContext(
		workflow,
		node,
		additionalData,
		'trigger',
		'activate',
		onEmit,
		(error) => {
			throw error;
		},
		async () => await saveStaticData(rc.env, workflow),
	);
	return await nodeTypes.getByNameAndVersion(node.type, node.typeVersion).poll!.call(context);
}
