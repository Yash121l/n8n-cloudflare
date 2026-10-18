import { Container } from '@n8n/di';
import { BinaryDataConfig, BinaryDataService, TEMP_EXECUTION_ID } from 'n8n-core';
import type { IBinaryData, IRun } from 'n8n-workflow';

type RenameEntry = {
	binaryDataRefs: IBinaryData[];
	mode: string;
	fileId: string;
	correctFileId: string;
};

function collectRenameEntries(run: IRun, executionId: string): RenameEntry[] {
	const entriesByFileId = new Map<string, RenameEntry>();
	for (const nodeRuns of Object.values(run.data.resultData.runData)) {
		for (const nodeRun of nodeRuns ?? []) {
			for (const outputs of nodeRun.data?.main ?? []) {
				for (const item of outputs ?? []) {
					for (const binaryData of Object.values(item?.binary ?? {})) {
						const binaryDataId = binaryData?.id;
						if (!binaryDataId) continue;
						const separator = binaryDataId.indexOf(':');
						const mode = binaryDataId.slice(0, separator);
						const fileId = binaryDataId.slice(separator + 1);
						if (separator < 0 || !fileId.includes(`/${TEMP_EXECUTION_ID}/`)) continue;
						const existing = entriesByFileId.get(fileId);
						if (existing) existing.binaryDataRefs.push(binaryData);
						else
							entriesByFileId.set(fileId, {
								binaryDataRefs: [binaryData],
								mode,
								fileId,
								correctFileId: fileId.replace(`/${TEMP_EXECUTION_ID}/`, `/${executionId}/`),
							});
					}
				}
			}
		}
	}
	return [...entriesByFileId.values()];
}

/**
 * Port of restoreBinaryDataId (packages/cli/src/execution-lifecycle/restore-binary-data-id.ts).
 * A Webhook node writes binary data before the execution has an ID, so the file goes under the
 * `temp` execution ID. This moves the file to the real ID and updates the references in the run.
 * Stock does this only in webhook mode. Here it runs in every mode, because pruning deletes old
 * `temp` files, and a test webhook (manual mode) run would then lose its uploads.
 */
export async function restoreBinaryDataId(run: IRun, executionId: string): Promise<void> {
	if (Container.get(BinaryDataConfig).mode === 'default') return;
	try {
		const entries = collectRenameEntries(run, executionId);
		await Promise.all(
			entries.map(
				async ({ fileId, correctFileId }) =>
					await Container.get(BinaryDataService).rename(fileId, correctFileId),
			),
		);
		for (const { binaryDataRefs, mode, correctFileId } of entries) {
			for (const binaryData of binaryDataRefs) binaryData.id = `${mode}:${correctFileId}`;
		}
	} catch (error) {
		console.error(`Failed to restore binary data ID of execution ${executionId}`, error);
	}
}
