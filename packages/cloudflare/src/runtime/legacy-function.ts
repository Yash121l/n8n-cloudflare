import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { Function as StockFunction } from 'n8n-nodes-base/dist/nodes/Function/Function.node.js';
import { FunctionItem as StockFunctionItem } from 'n8n-nodes-base/dist/nodes/FunctionItem/FunctionItem.node.js';

import type { FunctionItemOutcome, JsExecSettings, TaskError } from './code-sandbox/types';

// The stock nodes run the code in vm2. These run it in the Code node sandbox, a Dynamic Worker, and keep the stock checks here.

interface SandboxError extends Error {
	lineNumber?: number;
}

/** The sandbox error with the message of the original error, without the `[line N]` of the Code node. */
function toSandboxError(error: unknown): SandboxError {
	if (error instanceof Error) return error;
	const { message, description, lineNumber, stack } = (error ?? {}) as Partial<TaskError>;
	const result: SandboxError = new Error(
		String(message ?? 'Unknown error').replace(/ \[line \d+\]$/, ''),
	);
	if (typeof description === 'string') result.name = description;
	if (typeof stack === 'string') result.stack = stack;
	if (typeof lineNumber === 'number') result.lineNumber = lineNumber;
	return result;
}

async function runInSandbox<T>(
	functions: IExecuteFunctions,
	nodeMode: 'function' | 'functionItem',
	continueOnFail: boolean,
) {
	const settings: JsExecSettings = {
		code: functions.getNodeParameter('functionCode', 0) as string,
		nodeMode,
		workflowMode: functions.getMode(),
		continueOnFail,
	};
	const result = await functions.startJob<T, unknown>('javascript', settings, 0);
	if (!result.ok) throw toSandboxError(result.error);
	return result.result;
}

export class Function extends StockFunction {
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const continueOnFail = this.continueOnFail();
		let items: INodeExecutionData[];
		try {
			items = this.helpers.normalizeItems(
				await runInSandbox<INodeExecutionData[]>(this, 'function', continueOnFail),
			);
			if (items === undefined) {
				throw new NodeOperationError(
					this.getNode(),
					'No data got returned. Always return an Array of items!',
				);
			}
			if (!Array.isArray(items)) {
				throw new NodeOperationError(
					this.getNode(),
					'Always an Array of items has to be returned!',
				);
			}
			for (const item of items) {
				if (item.json === undefined) {
					throw new NodeOperationError(
						this.getNode(),
						'All returned items have to contain a property named "json"!',
					);
				}
				if (typeof item.json !== 'object') {
					throw new NodeOperationError(this.getNode(), 'The json-property has to be an object!');
				}
				if (
					item.binary !== undefined &&
					(Array.isArray(item.binary) || typeof item.binary !== 'object')
				) {
					throw new NodeOperationError(this.getNode(), 'The binary-property has to be an object!');
				}
			}
		} catch (e) {
			const error = e as SandboxError;
			if (continueOnFail) return [[{ json: { error: error.message } }]];
			if (error.lineNumber !== undefined)
				error.message = `${error.message} [Line ${error.lineNumber}]`;
			throw error;
		}
		return [items];
	}
}

export class FunctionItem extends StockFunctionItem {
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const continueOnFail = this.continueOnFail();
		const codeError = (error: SandboxError, itemIndex: number) => {
			const line = error.lineNumber === undefined ? '' : `Line ${error.lineNumber} | `;
			error.message = `${error.message} [${line}Item Index: ${itemIndex}]`;
			return error;
		};
		let outcomes: FunctionItemOutcome[];
		try {
			outcomes = await runInSandbox<FunctionItemOutcome[]>(this, 'functionItem', continueOnFail);
		} catch (e) {
			// A syntax error stops the sandbox before the first item. Stock fails each item.
			const error = e as SandboxError;
			if (!continueOnFail) throw codeError(error, 0);
			return [this.getInputData().map(() => ({ json: { error: error.message } }))];
		}

		const returnData: INodeExecutionData[] = [];
		for (let itemIndex = 0; itemIndex < outcomes.length; itemIndex++) {
			const outcome = outcomes[itemIndex];
			if ('error' in outcome) {
				const error = toSandboxError(outcome.error);
				if (!continueOnFail) throw codeError(error, itemIndex);
				returnData.push({ json: { error: error.message } });
				continue;
			}
			try {
				if (outcome.json === undefined) {
					throw new NodeOperationError(
						this.getNode(),
						'No data got returned. Always an object has to be returned!',
					);
				}
				returnData.push({
					json: outcome.json as IDataObject,
					pairedItem: { item: itemIndex },
					...(outcome.binary ? { binary: outcome.binary as INodeExecutionData['binary'] } : {}),
				});
			} catch (error) {
				if (!continueOnFail) throw error;
				returnData.push({
					json: { error: (error as Error).message },
					pairedItem: { item: itemIndex },
				});
			}
		}
		return [returnData];
	}
}
