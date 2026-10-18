# Execution storage layout

The runtime (`src/runtime`, `src/execution`) owns writes. The REST layer only reads, through the
functions in `src/runtime/service.ts` and the `execution_entity` table.

## D1: `execution_entity`

One row for each execution. `id` is the integer primary key; the API sends it as a string.

- `status`: `new`, `running`, `success`, `error`, `canceled`, `crashed` or `waiting`
- `finished`: 1 when `status` is `success`
- `waitTill`: ISO time when a waiting execution resumes; `NULL` when it waits for a webhook or form
- `instanceId`: `runner:<workflowId>`, the ExecutionRunner Durable Object that runs the execution, used to stop it
- `deletedAt`: set when the save settings discard the execution or pruning marks it. The cron handler deletes the row and its R2 keys after `EXECUTIONS_DATA_HARD_DELETE_BUFFER` hours
- `occurrenceKey`: unique key of a schedule or poll occurrence, so a retried handoff creates no second execution
- `workflowVersionId`: `versionId` of the workflow snapshot

## R2: bucket bound as `STORAGE`

| Key | Content |
|---|---|
| `executions/<id>/data.json` | `IRunExecutionData` serialized with `flatted.stringify` (same as the `data` column of stock `execution_data`) |
| `executions/<id>/workflow.json` | `IWorkflowBase` JSON snapshot of the workflow the execution ran (stock `execution_data.workflowData`) |
| `executions/<id>/request.json` | Runtime-private: the run request that the runner reads on a resume |
| `executions/<id>/webhook.json` | Runtime-private: response settings that the runner uses to answer a webhook request |
| `binary/<executionId>/<workflowId>/<uuid>` | Binary data written by nodes (`binary/custom/...` for data outside executions). Read it with `readBinaryData` |
| `binary/temp/<workflowId>/<uuid>` | Webhook uploads written before the execution has an ID. The run moves them to its ID when it ends or waits. The cron prune deletes leftovers older than the hard-delete buffer and older than every execution in progress |

`GET /rest/executions/:id` returns the row fields, `data` as the raw flatted string, and
`workflowData` parsed from `workflow.json`. Use `readExecutionData` and `readExecutionWorkflow`
from `src/runtime/service.ts`. Deleting an execution deletes the row and every key under
`executions/<id>/` and `binary/<id>/` (use `deleteExecutionData`).

## What the REST layer reads and writes

- `GET /rest/executions` reads only `execution_entity` joined with `workflow_entity` for the workflow name. Pages use `id < cursor` and sort by `id DESC`. The cursor is base64url of `{"version":1,"v1":{"id","timestamp"}}`, the same as stock n8n.
- `GET /rest/executions/:id` calls `readExecutionData` and `readExecutionWorkflow`. If no snapshot exists, it falls back to the current `workflow_entity` row. A running or waiting execution with no data returns empty run data. A finished execution with no data returns 404, as stock n8n does.
- `POST /rest/executions/delete` selects the matching ids, calls `deleteExecutionData`, then deletes the D1 rows (`execution_metadata` rows go with them by cascade).
- `POST /rest/executions/:id/stop` calls `stopExecution` and then reads the row again. The runtime must set `status` to `canceled` and `stoppedAt` before it returns.
- Every execution row needs `workflowId` set to a workflow with a `shared_workflow` row. The list hides executions of workflows the user cannot access.
