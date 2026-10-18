// Calls startRunnerTask with a fake node context, so tests can inspect the host isolate after each task.
import { Workflow } from 'n8n-workflow';
import type {
	IDataObject,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeTypeDescription,
	IRunExecutionData,
	IWorkflowExecuteAdditionalData,
} from 'n8n-workflow';
import { createRunExecutionData } from 'n8n-workflow';

import { startRunnerTask } from '../../src/runtime/code-runner';
import type { JsExecSettings } from '../../src/runtime/code-sandbox/types';

const description: INodeTypeDescription = {
	displayName: 'Code',
	name: 'n8n-nodes-base.code',
	group: ['transform'],
	version: 2,
	description: 'Run code',
	defaults: { name: 'Code' },
	inputs: ['main'],
	outputs: ['main'],
	properties: [],
};
const nodes: INode[] = [
	{
		id: 'source',
		name: 'Source',
		type: description.name,
		typeVersion: 2,
		position: [0, 0],
		parameters: {},
	},
	{
		id: 'code',
		name: 'Code',
		type: description.name,
		typeVersion: 2,
		position: [200, 0],
		parameters: {},
	},
];
const nodeTypes = {
	getByName: () => ({ description }),
	getByNameAndVersion: () => ({ description }),
	getKnownTypes: () => ({}),
};

interface RunRequest {
	jobType?: 'javascript' | 'python';
	settings: JsExecSettings;
	items?: INodeExecutionData[];
	staticData?: IDataObject;
}

export default {
	async fetch(request: Request): Promise<Response> {
		const {
			jobType = 'javascript',
			settings,
			items = [{ json: { n: 1 } }, { json: { n: 2 } }],
			staticData,
		} = await request.json<RunRequest>();
		const logs: string[][] = [];
		const helperCalls: string[] = [];
		const functions = {
			helpers: {
				binaryToString: async (value: Buffer) => value.toString('utf8'),
				getBinaryDataBuffer: async (itemIndex: number, property: string) => {
					helperCalls.push(`getBinaryDataBuffer:${itemIndex}:${property}`);
					return Buffer.from('binary round trip');
				},
				prepareBinaryData: async (data: Buffer, fileName?: string) => {
					helperCalls.push(`prepareBinaryData:${Buffer.isBuffer(data)}:${fileName}`);
					return { data: data.toString('base64'), mimeType: 'text/plain', fileName };
				},
			},
			logNodeOutput: (...args: string[]) => logs.push(args),
		} as unknown as IExecuteFunctions;
		const runExecutionData: IRunExecutionData = createRunExecutionData({
			resultData: {
				runData: {
					Source: [
						{
							startTime: 0,
							executionTime: 0,
							executionIndex: 0,
							source: [],
							data: { main: [items] },
						},
					],
				},
			},
		});
		const workflow = new Workflow({
			id: 'workflow',
			nodes,
			connections: { Source: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
			active: false,
			nodeTypes,
			staticData,
		});
		const additionalData = {
			executionId: 'execution',
			webhookWaitingBaseUrl: 'http://localhost/webhook-waiting',
			formWaitingBaseUrl: 'http://localhost/form-waiting',
			variables: { example: 'variable' },
		} as unknown as IWorkflowExecuteAdditionalData;
		const started = performance.now();
		const output = await startRunnerTask(
			additionalData,
			jobType,
			jobType === 'python' ? { items, ...settings } : settings,
			functions,
			{ main: [items] },
			nodes[1],
			workflow,
			runExecutionData,
			0,
			0,
			'Code',
			items,
			{},
			'manual',
			{ env: {}, isEnvAccessBlocked: true, isProcessAvailable: false },
			{ node: nodes[1], data: { main: [items] }, source: { main: [{ previousNode: 'Source' }] } },
		);
		const elapsedMs = performance.now() - started;
		return Response.json({
			output,
			logs,
			helperCalls,
			elapsedMs,
			metadata: runExecutionData.resultData.metadata ?? null,
			staticData: workflow.staticData,
			staticDataChanged: workflow.staticData.__dataChanged === true,
			host: {
				prototype: Object.hasOwn(Object.prototype, 'n8nProbe'),
				json: JSON.stringify({ clean: true }),
				global: Object.hasOwn(globalThis, 'n8nProbe'),
			},
		});
	},
};
