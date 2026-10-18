Report on how `packages/cli` in n8n 2.15.0 works, for the Cloudflare Workers port. All paths below are relative to `/Users/admin/.t3/scratch/2026-10-16-hey-i-want-your-help-3fc54a9d/n8n/packages/`. The 2-minute test-webhook timeout and the auth defaults are cited; other environment defaults (`N8N_PUSH_BACKEND`, `N8N_JWT_SECRET`) come from the config source or general knowledge and weren't checked one by one.

---

## 1. DB schema and serialization

Entity files are in `@n8n/db/src/entities/`. Table names use TypeORM's default snake_case, e.g. `workflow_entity`, `execution_entity`, `execution_data`, `credentials_entity`, `user`, `project`, `project_relation`, `shared_workflow`, `shared_credentials`, `webhook_entity`, `settings`, `tag_entity`, `workflows_tags`, `workflow_history`, `execution_metadata`, `workflow_published_version`. There may also be a `tablePrefix`. The SQLite migrations (`@n8n/db/src/migrations/sqlite/`, 55 files) give the exact DDL to port to D1.

**Base mixins (`abstract-entity.ts`)**
- `WithStringId` (L58-71): `id varchar` primary key, set to `generateNanoId()` before insert.
- `WithTimestamps`: `createdAt` and `updatedAt`, datetime with precision 3. The SQLite default is `STRFTIME('%Y-%m-%d %H:%M:%f','NOW')` (L18).
- JSON columns: `simple-json` on SQLite, which is TEXT holding `JSON.stringify` output (L29-35). On Postgres they are `json`.
- Datetime columns: `datetime` on SQLite, `timestamptz` on Postgres.

**Entities**

| Entity (file) | Key columns |
|---|---|
| `WorkflowEntity` (`workflow-entity.ts`; string id + timestamps) | `name varchar(128)` unique; `description text?`; `active bool` (still present); `isArchived bool=false`; `nodes json` (INode[]); `connections json`; `settings json?`; `staticData json?`; `meta json?`; `pinData` (text on SQLite, JSON-stringified, L93-98); `versionId varchar(36)`; `activeVersionId varchar(36)?`, a foreign key to `workflow_history.versionId` (L103-108); `versionCounter int=1`; `triggerCount int=0`; `parentFolderId?` |
| `WorkflowHistory` (`workflow-history.ts`; timestamps) | PK `versionId`; `workflowId`; `nodes json`; `connections json`; `authors varchar`; `name text?`; `description text?`; `autosaved bool` |
| `WorkflowPublishedVersion` | PK `workflowId`; `publishedVersionId` |
| `ExecutionEntity` (`execution-entity.ts`) | `id` is an integer AUTOINCREMENT (`@Generated`, L32-34) exposed as a string through `idStringifier`; `finished bool` (deprecated); `mode varchar`; `retryOf?`; `retrySuccessId?`; `status varchar` (`new|running|success|error|canceled|crashed|waiting`); `createdAt`; `startedAt?`; `stoppedAt?` (indexed); `deletedAt` (soft delete); `workflowId?`; `waitTill datetime?`; `storedAt varchar(2) default 'db'` (`db` or `fs`). Indexes at L26-30 include `(waitTill,id)` and `(workflowId,finished,id)` |
| `ExecutionData` (`execution-data.ts`) | PK and FK `executionId` (cascade delete); `data text` (flatted string); `workflowData json` (snapshot); `workflowVersionId varchar(36)?` |
| `ExecutionMetadata` | `id` autoincrement; `executionId`; `key text`; `value text` |
| `CredentialsEntity` (`credentials-entity.ts`; string id + timestamps) | `name varchar(128)`; `data text` (encrypted, see below); `type varchar(128)` (indexed); `isManaged`, `isGlobal`, `isResolvable`, `resolvableAllowFallback` (all bool); `resolverId?` |
| `User` (`user.ts`; timestamps) | `id uuid`; `email varchar(254)` unique, lowercased; `firstName`/`lastName varchar(32)`; `password` (bcrypt hash, nullable); `personalizationAnswers json`; `settings json`; `roleSlug` FK to `role.slug` (e.g. `global:owner`); `disabled`; `mfaEnabled`; `mfaSecret`; `mfaRecoveryCodes simple-array`; `lastActiveAt date` |
| `Project` (string id + timestamps) | `name varchar(255)`; `type` (`personal`/`team`); `icon json`; `description`; `creatorId` |
| `ProjectRelation` | PK (`userId`, `projectId`); `role` FK to `role.slug` |
| `SharedWorkflow` | PK (`workflowId`, `projectId`); `role` (`workflow:owner`/`workflow:editor`) |
| `SharedCredentials` | PK (`credentialsId`, `projectId`); `role` (`credential:owner`/`credential:user`) |
| `WebhookEntity` (`webhook-entity.ts`) | PK (`webhookPath`, `method`); `workflowId`; `node` (node name); `webhookId?`; `pathLength?`; index `(webhookId, method, pathLength)`. Cache key `webhook:${method}-${uniquePath}` (L39) |
| `Settings` | PK `key`; `value text` (JSON string); `loadOnStartup bool` |
| `TagEntity` | `name varchar(24)` unique; junction table `workflows_tags(workflowId, tagId)` |

**Execution data serialization**
- On write: `ExecutionPersistence.create()` (`cli/src/executions/execution-persistence.ts` L36-67) runs `stringify(rawData)` from `flatted` and inserts `execution_entity` plus `execution_data` in one transaction.
- In `fs` mode the data goes to a bundle file at `<storagePath>/workflows/<wfId>/executions/<execId>/execution_data/<bundle>` instead (`fs-store.ts` L82-97). That layout maps directly to R2 keys if you want it.
- On update: `ExecutionRepository.updateExistingExecution` also uses flatted `stringify` (`@n8n/db/src/repositories/execution.repository.ts` L404-424).
- On read: `parseFlatted` and then `migrateRunExecutionData` (L1180-1194). A missing `version` field means v0 and is migrated to v1 (`workflow/src/run-execution-data/run-execution-data.ts` L23-40).
- The workflow snapshot stored with an execution is `{connections, nodes, name, settings, id}`.
- `GET /rest/executions/:id` returns `data` re-flatted (`cli/src/executions/execution.service.ts` L166). The frontend calls `unflattenExecutionData` on it.

**Credential encryption (`core/src/encryption/cipher.ts`)**

This is the CryptoJS/OpenSSL-compatible "Salted__" format:
- Output is `base64( "Salted__"(8 bytes, hex 53616c7465645f5f) || salt(8 random bytes) || AES-256-CBC ciphertext with PKCS#7 padding )`.
- Key derivation is OpenSSL `EVP_BytesToKey` with MD5 and one iteration. With `password = Buffer.from(encryptionKey,'binary') || salt`:
  - `h1 = md5(password)`
  - `h2 = md5(h1 || password)`
  - `iv = md5(h2 || password)`
  - `key = h1 || h2` (32 bytes)
- Plaintext is `JSON.stringify(credentialDataObject)`. Decrypting an input shorter than 16 bytes returns `''`.
- `Credentials` (`core/src/credentials.ts` L22-63) wraps this and parses the decrypted string with `jsonParse`.

Porting notes for Workers:
- WebCrypto supports AES-CBC with PKCS7, but it does not support MD5. Use a small JS MD5 implementation; `node:crypto` under `nodejs_compat` may also work.
- `'binary'` encoding is latin1, so each character's code is truncated to one byte.

**Where `encryptionKey` comes from** (`core/src/instance-settings/instance-settings.ts`)
- It is read from `N8N_ENCRYPTION_KEY` or from `~/.n8n/config`. If neither exists, it is generated as `randomBytes(24).toString('base64')` (L228).
- `instanceId = sha256(encryptionKey.slice(round(len/2))).hex` (L238-243).
- `hmacSignatureSecret = sha256("hmac-signature:"+encryptionKey).hex`, unless `N8N_HMAC_SIGNATURE_SECRET` is set (L245-251). This secret is used for send-and-wait URL signatures.

---

## 2. Manual execution path

1. **Controller.** `POST /rest/workflows/:workflowId/run` is handled by `WorkflowsController.runManually` (`cli/src/workflows/workflows.controller.ts` L513-552). It requires scope `workflow:execute`. It always loads the workflow from the DB and ignores any workflow sent in the body. It reads `req.headers['push-ref']`.
2. **Response.** The return value goes through `sendSuccessResponse`, so it is wrapped as `{"data": ...}` (`cli/src/response-helper.ts` L15-45). The actual response is `{"data":{"executionId":"123"}}` or `{"data":{"waitingForWebhook":true}}`. It returns immediately and does not wait for the run to finish.
3. **Body types** (`workflows/workflow.request.ts` L33-62):
   - Full run from a known trigger: `{triggerToStartFrom:{name,data?}, destinationNode?, chatSessionId?, agentRequest?}`
   - Full run from an unknown trigger: `{destinationNode:{nodeName,mode}}`
   - Partial run: `{runData, destinationNode, dirtyNodeNames}`
4. **`WorkflowExecutionService.executeManually`** (`workflows/workflow-execution.service.ts` L104-261):
   - Sets `active=false` and `activeVersionId=null`.
   - For full runs where the trigger has no pin data, it calls `testWebhooks.needsWebhook(...)`. If that registers test webhooks, it returns `{waitingForWebhook:true}`.
   - Otherwise it builds `IWorkflowExecutionDataProcess` as `{executionMode:'manual', pinData, pushRef, workflowData, userId, triggerToStartFrom, destinationNode, runData?, dirtyNodeNames?, projectId, projectName}` and calls `workflowRunner.run(data)`.
5. **`WorkflowRunner.run`** (`cli/src/workflow-runner.ts` L139-218):
   - `activeExecutions.add()` (`active-executions.ts` L62-140) inserts the execution row with status `new` (data is flatted `executionData`, usually undefined for manual runs), reserves concurrency, then `setRunning` sets status `running` and `startedAt`.
   - For resumes (`restartExecutionId` given), it calls `updateExistingExecution(..., {requireStatus:'waiting'})`.
   - Then it checks credential permissions. On failure it records a failed run through the hooks.
   - Then `runMainProcess` (L221-380):
     - Builds a `new Workflow({... active: activeVersionId!==null, pinData})` (pin data only for manual/evaluation runs).
     - Calls `getBase({userId, workflowId, executionTimeoutTimestamp, workflowSettings})`.
     - Calls `setRunning`.
     - Sets `additionalData.hooks = getLifecycleHooksForRegularMain(data, executionId)`, plus `setExecutionStatus` and `sendDataToUI` (bound to `pushRef`).
     - If `data.executionData` exists (resume, webhook or trigger runs), it runs `new WorkflowExecute(additionalData, mode, executionData).processRunExecutionData(workflow)`. Otherwise it calls `ManualExecutionService.runManually`.
     - It sets up the timeout and, on completion, calls `activeExecutions.finalizeExecution`.
6. **`ManualExecutionService.runManually`** (`cli/src/manual-execution.service.ts` L49-200) has three branches:
   - `triggerToStartFrom.data` together with `startNodes`: rebuilds the execution stack and calls `processRunExecutionData`.
   - No `runData`: full run via `WorkflowExecute.run({workflow, startNode, destinationNode, pinData, triggerToStartFrom, additionalRunFilterNodes})`. It rewires the graph for AI tool destination nodes.
   - Otherwise: `runPartialWorkflow2(workflow, runData, pinData, dirtyNodeNames, destinationNode, agentRequest)`.

**`getBase`** (`cli/src/workflow-execute-additional-data.ts` L453-556) returns:
- `credentialsHelper` (the `CredentialsHelper` instance)
- `executeWorkflow` (sub-workflows)
- `restApiUrl`, `instanceBaseUrl`, `formWaitingBaseUrl`, `webhookBaseUrl`, `webhookWaitingBaseUrl`, `webhookTestBaseUrl`, all of the form `urlBaseWebhook + endpoints.*`
- `variables` (from `WorkflowHelpers.getVariables(workflowId, projectId)`)
- `setExecutionStatus`
- `getRunExecutionData(id)` (loads the unflatted execution from the DB)
- `externalSecretsProxy`
- `startRunnerTask` (the task runner used by the Code node)
- `logAiEvent`, `getRunnerStatus`
- optional `ssrfBridge`
- per-module context

`sendDataToUI(type, data)` calls `Push.send({type,data}, pushRef)` (L428-442).

**Lifecycle hooks** (`cli/src/execution-lifecycle/execution-lifecycle-hooks.ts`)

For regular main runs (L789-815) the order is: workflow events, node events, finalize status, **Save**, **Push**, SaveProgress, statistics, external hooks, module hooks. Push messages (L218-404), only sent when `pushRef` is set:

| Hook | Message sent |
|---|---|
| `workflowExecuteBefore` | `{type:'executionStarted', data:{executionId, mode, startedAt, retryOf, workflowId, workflowName, flattedRunData: flatted.stringify(redactedRunData or {})}}` |
| `nodeExecuteBefore` | `{type:'nodeExecuteBefore', data:{executionId, nodeName, data: ITaskStartedData}}` |
| `nodeExecuteAfter` | First `{type:'nodeExecuteAfter', data:{executionId, nodeName, itemCountByConnectionType, data: taskData without .data}}`, then, after redaction, `{type:'nodeExecuteAfterData', data:{executionId, nodeName, itemCountByConnectionType, data: ITaskData}}` sent as a binary WebSocket frame |
| `workflowExecuteAfter`, status `waiting` | `{type:'executionWaiting', data:{executionId}}` |
| `workflowExecuteAfter`, otherwise | `{type:'executionFinished', data:{executionId, workflowId, status}}` |

Save on `workflowExecuteAfter` (`hookFunctionsSave`, L475-588):
- Restores binary data IDs.
- Saves `staticData` for non-manual runs.
- Manual run with `saveSettings.manual` false and no `waitTill`: soft-deletes the execution (`deletedAt`) and returns.
- Non-manual run that shouldn't be saved per the success/error settings: runs the error workflow and deletes the execution.
- Otherwise:
  - Builds `prepareExecutionDataForDbUpdate` (`shared/shared-hook-functions.ts` L28-74), which picks `{id,name,active,activeVersionId,isArchived,createdAt,updatedAt,nodes,connections,settings,staticData,pinData}`.
  - If the run is manual and waiting, stores `data.pushRef = pushRef` in the run data.
  - Calls `updateExistingExecution` (data flatted), then metadata, then sets `retrySuccessId` on the original execution.
  - Runs the error workflow for non-manual runs.
- `saveExecutionProgress` writes after each node when that setting is on.

**After the run.** The editor reacts to `executionFinished` by calling `GET /rest/executions/:id` (`frontend/editor-ui/src/app/composables/usePushConnection/handlers/executionFinished.ts` L130, L205-210). That endpoint returns `{data:{..., data: <flatted string>}}`.

---

## 3. Webhooks

**Routing** (`cli/src/abstract-server.ts` L231-264). These routes are registered before body parsing, so raw bodies are available.

| Route | Handler |
|---|---|
| `/{webhook}/*path`, `/{form}/*path`, `/{mcp}/*path` | `LiveWebhooks` |
| `/{webhookWaiting}/:path{/:suffix}` | `WaitingWebhooks` |
| `/{formWaiting}/:path{/:suffix}` | `WaitingForms` |
| `/{webhookTest}/*path`, `/{formTest}/*path`, `/{mcpTest}/*path` | `TestWebhooks` |
| `DELETE /rest/test-webhook/:id` | `testWebhooks.cancelWebhook` |

`WebhookRequestHandler` (`webhooks/webhook-request-handler.ts`):
- Allows only DELETE, GET, HEAD, PATCH, POST, PUT and OPTIONS. OPTIONS gets a 204.
- Sets CORS headers only when an `Origin` header is present. Allowed methods come from `getWebhookMethods`; `allowedOrigins` comes from the node's `options`.
- Calls `manager.executeWebhook(req,res)` and sends either a `WebhookResponse` (static, stream or none) or the legacy `{data, responseCode, headers}`, with `raw=true` meaning the body isn't wrapped.
- Adds a sandboxing CSP header to webhook responses unless that is disabled.

**Production lookup** (`webhook.service.ts` L46-123; `live-webhooks.ts`):
- Strips a trailing slash, then tries the cache, then a static lookup `findOneBy({webhookPath: path, method})`.
- If that fails, it tries a dynamic lookup: split `<webhookId>/<rest>`, query by `{webhookId, method, pathLength: rest.length}`, and pick the candidate with the most matching static segments. `:param` values go into `req.params`.
- It then loads the workflow with its `activeVersion` and `shared` relations, builds the `Workflow` from the activeVersion's nodes and connections, calls `getBase({projectId: owner})`, finds the matching `IWebhookData` from `getNodeWebhooks`, and calls `WebhookHelpers.executeWebhook(..., mode 'webhook')`.

**Stored path format** (`workflow/src/node-helpers.ts` L1058-1083):
- No `webhookId` on the node: `${workflowId}/${encodeURIComponent(nodeName.toLowerCase())}/${path}`.
- Otherwise, if `isFullPath`: `path || webhookId`. If not: `${webhookId}/${path}`.
- Activation strips leading and trailing slashes. For dynamic paths it sets `webhookId` and `pathLength` (`active-workflow-manager.ts` L165-185).

**`WebhookHelpers.executeWebhook`** (`webhooks/webhook-helpers.ts` L414-939):
1. Parses the body.
2. Runs `nodeType.webhook(context)` through `WebhookService.runWebhook`.
3. If the result is `noWebhookResponse`, the node already responded.
4. If the result has no `workflowData`, it responds with `webhookResponse` or `{message:'Webhook call received'}` and does not run the workflow.
5. Otherwise it calls `prepareExecutionData` (L351-407), which puts the start node on `nodeExecutionStack` with `main: workflowData`, then `WorkflowRunner.run(runData, true, realtime, executionId?, responsePromise)`.

Response mode comes from `autoDetectResponseMode` or the node's `responseMode` parameter (default `onReceived`). Valid values are `onReceived`, `lastNode`, `responseNode`, `formPage`, `streaming` and `hostedChat` (L483).

| Mode | Behavior |
|---|---|
| `onReceived` | Response is deferred until the execution ID exists, so `$execution.id` resolves (L636, L750-776). Body is `extractWebhookOnReceivedResponse` (`webhook-on-received-response-extractor.ts`): `'noData'` gives an empty body, then the evaluated `responseData` option, then `webhookResponse`, then `{message:'Workflow was started'}` |
| `lastNode` | Waits for `postExecutePromise`. Errors give 500 `{message:'Error in workflow'}`. If the last node has no data: `{message:'Workflow executed successfully but the last node did not return any data'}`. Otherwise `extractWebhookLastNodeResponse` with `responseData` = `firstEntryJson`/`firstEntryBinary`/`allEntries`/`noData`, `responsePropertyName`, `responseContentType`, `responseBinaryPropertyName` (L825-910) |
| `responseNode` | A `responsePromise` is attached to the active execution. The Respond to Webhook node fires the `sendResponse` hook, which calls `activeExecutions.resolveResponsePromise`. `setupResponseNodePromise` (L293-342) then writes the body, buffer or binary stream with its status and headers |
| `streaming` | `runData.httpResponse = res`, `streamingEnabled`; the `sendChunk` hook writes NDJSON (`workflow-runner.ts` L289-294) |
| `formPage` | Responds `{formWaitingUrl}` |

**Test webhooks** (`webhooks/test-webhooks.ts`):
- `needsWebhook` (L285-434) collects the workflow's webhooks.
- Registrations are stored in a cache hash `test-webhooks` keyed by `METHOD|path`, or `METHOD|webhookId|segmentCount` for dynamic paths (`test-webhook-registrations.service.ts` L116-130). The value is `{version:1, pushRef, workflowEntity, destinationNode, webhook (+userId, isTest, staticData)}`, with TTL equal to the timeout plus a buffer.
- It runs the node's `webhookMethods.create`/`checkExists` with `'manual'`.
- A timer of `TEST_WEBHOOK_TIMEOUT` (2 minutes, `cli/src/constants.ts` L87) calls `cancelWebhook`, which pushes `testWebhookDeleted`.
- On an incoming request, `executeWebhook` (L67-196) finds the registration, runs `WebhookHelpers.executeWebhook` with mode `'manual'` and `pushRef`, pushes `{type:'testWebhookReceived', data:{workflowId, executionId}}`, then deactivates the test webhooks.

**Waiting webhooks** (`webhooks/waiting-webhooks.ts`):
1. `:path` is the executionId. The execution is loaded unflatted.
2. If `data.resumeToken` is set, the `?signature=` query parameter is checked with a timing-safe compare. Send-and-wait nodes use an HMAC URL signature with `hmacSignatureSecret` instead. `resumeToken` is generated by `createRunExecutionData` through `generateSecureToken()` (`workflow/src/run-execution-data-factory.ts` L95).
3. It rejects executions that are running, errored or finished.
4. It disables `nodeExecutionStack[0].node` and clears `waitTill`.
5. It finds a webhook on `lastNodeExecuted` that matches the method, has `path === suffix ?? ''` and `restartWebhook === true`.
6. It calls `WebhookHelpers.executeWebhook(workflow, ..., execution.mode, runExecutionData.pushRef, runExecutionData, execution.id, ...)`. The runner then calls `activeExecutions.add` with the existing id, which updates the row only if `status='waiting'`. Otherwise it throws `ExecutionAlreadyResumingError`.

The resume URL is `${webhookWaitingBaseUrl}/${executionId}?signature=<resumeToken>` (`core/src/execution-engine/node-execution-context/utils/get-additional-keys.ts` L29-31; `WAITING_TOKEN_QUERY_PARAM='signature'`, `core/src/constants.ts` L23).

---

## 4. Activation, triggers, pollers and waits

**`ActiveWorkflowManager.add`** (`cli/src/active-workflow-manager.ts` L598-718):
1. Uses `dbWorkflow.activeVersion` (`nodes`/`connections` from `workflow_history`).
2. Validates that the workflow has a trigger-like node.
3. Calls `getBase({workflowId, workflowSettings})`.
4. **Webhooks** (`addWebhooks`, L150-232): for each webhook from `getWorkflowWebhooks(..., ignoreRestartWebhooks=true)`, it inserts a `webhook_entity` row (`storeWebhook`) and calls `createWebhookIfNotExists`, which runs the node's `webhookMethods.checkExists` and `create` to register with third-party services. A duplicate key becomes `WebhookPathTakenError`. Finally it saves `staticData`.
5. **Triggers and pollers** (`addTriggersAndPollers`, L981-1025) go through core `ActiveWorkflows.add` (`core/src/execution-engine/active-workflows.ts` L70-135):
   - Trigger nodes: `nodeType.trigger.call(TriggerContext)` returns `{closeFunction, manualTriggerFunction}` (`triggers-and-pollers.ts` L26-86). The context's `emit(data)` calls `WorkflowExecutionService.runWorkflow` (L57-90), which builds `createRunExecutionData({executionData:{nodeExecutionStack:[{node, data:{main:data}, source:null}]}})` and runs `WorkflowRunner.run` with mode `trigger`. `emitError` deactivates the workflow, records the activation error, runs the error workflow and queues a reactivation.
   - Poll nodes (L141-178): reads the `pollTimes` parameter, maps each entry through `toCronExpression`, runs the poll once immediately as a test, then registers a cron per expression. Second-level `*` is rejected. In `getExecutePollFunctions` (L301-347), `__emit` runs the workflow.
6. Updates `triggerCount`.

**ScheduledTaskManager** (`core/src/execution-engine/scheduled-task-manager.ts`):
- In-process `CronJob(expression, onTick, tz)`, keyed per workflow. Ticks only run on the leader.
- The Schedule Trigger calls `this.helpers.registerCron({expression, recurrence}, ...)` (`nodes-base/nodes/Schedule/ScheduleTrigger.node.ts` L470-481; `core/.../utils/scheduling-helper-functions.ts` L13-22). Its `recurrenceCheck` uses `staticData.recurrenceRules` for every-N-weeks/months intervals. It emits `{timestamp, 'Readable date', ...}`.
- `toCronExpression` (`workflow/src/cron.ts` L52-72) produces 6-field crons with seconds and a random second, for example `"${rs} */${n} * * * *"`.

Cloudflare Cron Triggers only fire at minute granularity and use static schedules. You'd need a per-workflow Durable Object alarm scheduler that computes the next time with a cron parser.

**WaitTracker** (`cli/src/wait-tracker.ts`):
- Leader only. Polls every 5 seconds with `getWaitingExecutions` (`execution.repository.ts` L605-620): `status='waiting' AND waitTill <= now+15s ORDER BY waitTill`.
- Sets a `setTimeout` for each result, which calls `startExecution`: load unflatted, then `WorkflowRunner.run({executionMode: original, executionData, workflowData, projectId, pushRef: data.pushRef, startedAt}, false, false, executionId)`. It then resumes the parent execution if needed.
- `WAIT_INDEFINITELY = 3000-01-01T00:00:00Z` (`workflow/src/constants.ts` L7) is used by "resume on webhook" waits.

This maps naturally to a DO alarm per waiting execution, or a Workflows `step.sleepUntil`.

---

## 5. Push

**Backend** (`cli/src/push/`):
- `N8N_PUSH_BACKEND` is `websocket` (default) or `sse` (`push.config.ts`). The frontend learns which one from settings (`pushBackend`).
- **Endpoint:** `/{rest}/push?pushRef=<id>`. It runs the auth middleware (cookie; the browser-id check is skipped for this path) and validates the Origin header in production (`index.ts` L94-149). A missing `pushRef` gets a 400, or for WebSocket, the message `The query parameter "pushRef" is missing!` and close code 1008.
- **pushRef:** a client-generated ID (`frontend/@n8n/stores/src/useRootStore.ts` L68 `getClientId()`). It is sent as the `push-ref` header on REST calls (`frontend/@n8n/rest-api-client/src/utils.ts` L184, L201) and as a query parameter on the push connection (`pushConnection.store.ts` L48-60).
- **Tracking** (`abstract.push.ts`): `connections[pushRef]` and `userIdByPushRef[pushRef]`. A new connection with the same pushRef closes the old one. There are `sendToOne(pushRef)`, `sendToUsers(userIds)` and `sendToAll` (broadcast, used for `workflowActivated` etc.). Every 60 seconds the server pings: WebSocket uses protocol ping/pong and terminates a socket that missed a pong; SSE writes `:ping\n\n`. A multi-main setup relays through pub/sub.

**Envelope:** `jsonStringify({type, data}, {replaceCircularRefs:true})` (L84). This is plain JSON, not flatted. The only flatted field is `executionStarted.data.flattedRunData`.
- **WebSocket:** `ws.send(str, {binary: asBinary})`. Only `nodeExecuteAfterData` goes as binary; the client decodes it as UTF-8 JSON. The client sends `{"type":"heartbeat"}`, which the server ignores (`@n8n/api-types/src/push/heartbeat.ts`).
- **SSE:** `Content-Type: text/event-stream; charset=UTF-8`, an initial `:ok\n\n`, then `data: <json>\n\n` per message (`sse.push.ts`).

**Message types** (`@n8n/api-types/src/push/*.ts`):
- Execution: `executionStarted`, `executionWaiting`, `executionFinished`, `executionRecovered`, `nodeExecuteBefore`, `nodeExecuteAfter`, `nodeExecuteAfterData`
- Webhooks: `testWebhookDeleted {executionId?, workflowId}`, `testWebhookReceived {executionId, workflowId}`
- Workflows: `workflowActivated {workflowId, activeVersionId}`, `workflowFailedToActivate {workflowId, errorMessage}`, `workflowDeactivated`, `workflowAutoDeactivated`, `workflowUpdated`
- Also collaboration, builder, debug, hot-reload and worker messages.

On Cloudflare this fits a Durable Object holding hibernatable WebSockets keyed by `pushRef` (or by user), with `serializeAttachment` storing `{pushRef, userId}`.

---

## 6. Node and credential types, and icons

**Build time.** Each node package's build runs `n8n-copy-static-files` and `n8n-generate-metadata` (`nodes-base/package.json` L11; `core/bin/`):
- `copy-static-files` copies `{nodes,credentials}/**/*.{png,svg}` and `__schema__` JSON into `dist/`.
- `generate-metadata` uses `PackageDirectoryLoader` to write `dist/types/nodes.json` (every version of every description, minus `__loadOptionsMethods`), `dist/types/credentials.json`, `dist/known/{nodes,credentials}.json` and `dist/methods/{defined,referenced}.json`.

**Server startup.** `FrontendService.generateTypes()` (`cli/src/services/frontend.service.ts` L390-402) applies credential overwrites, then calls `collectTypes()`. `postProcessLoaders` (`cli/src/load-nodes-and-credentials.ts` L500-560) prefixes node names with `${packageName}.`, for example `n8n-nodes-base.httpRequest`. It also maps credential `supportedNodes` to prefixed names and injects domain-restriction fields where applicable. The result is written to `<staticCacheDir>/types/{nodes,node-versions,credentials}.json` as a JSON array with one entry per line (`writeStaticJSON` L619-640).

**Serving** (`cli/src/server.ts` L299-345):
- `GET /types/nodes.json`, `/types/credentials.json` and `/types/node-versions.json` require auth (MFA and the browser-id check are skipped) and are sent with `Cache-Control: no-cache, must-revalidate`.
- Icons are served at `/icons/{@scope/}:packageName/*path/*file.(svg|png)` through `resolveIcon(packageName, url)` (L215-236), which resolves `path.resolve(loader.directory, urlPath)` and checks the result stays inside the package directory. Cache max-age is 1 day.
- Icon URLs in descriptions look like `iconUrl: "icons/<packageName>/<path relative to package dir>"`, e.g. `icons/n8n-nodes-base/dist/nodes/Foo/foo.svg`, or `{light, dark}` (`core/src/nodes-loader/directory-loader.ts` L418-462). When the icon is an expression, `iconBasePath` is used instead.

**Static on Cloudflare.** All of this can be generated once at build time with one script that does the same prefixing (and the credential overwrite/domain-restriction steps if you need them), then served as Workers Static Assets or from R2. That covers the three types JSON files, the icons (keep the `icons/<pkg>/dist/...` layout) and the `__schema__` files. Only the auth gate on `/types/*.json` needs Worker code.

---

## 7. Auth

**Password hashing.** `bcryptjs` with 10 salt rounds (`cli/src/services/password.utility.ts`). Hashes look like `$2a$10$...` or `$2b$10$...`. WebCrypto has no bcrypt, so use a pure-JS `bcryptjs` in Workers; 10 rounds costs roughly 50-100 ms of CPU.

**Cookie.** Named `n8n-auth` (`cli/src/constants.ts` L63). Issued by `issueCookie` (`auth/auth.service.ts` L207-223) with `httpOnly`, `sameSite` = `N8N_SAMESITE_COOKIE` (default `lax`), `secure` = `N8N_SECURE_COOKIE` (default true), and `maxAge` = `jwtSessionDurationHours` (default 168) × 3600 s.

**JWT.**
- HS256 via `jsonwebtoken`, with `expiresIn` equal to the session duration. Payload is `{id: userId, hash, browserId?, usedMfa, iat, exp}` (L225-235).
- `hash = base64(sha256([email, bcryptPassword, (mfaEnabled && mfaSecret ? mfaSecret.slice(0,3) : omitted)].join(':'))).substring(0,10)` (L396-406). It is standard base64, not url-safe. Changing the email, password or MFA settings invalidates existing tokens.
- `browserId` in the payload is `base64(sha256(browserIdHeader))`.

**Secret** (`cli/src/services/jwt.service.ts`): `N8N_USER_MANAGEMENT_JWT_SECRET` if set. Otherwise take every other character of `encryptionKey` (indices 0, 2, 4, …), then `sha256(thatString).hex`. The 64-character hex string is used as the UTF-8 HMAC key, not decoded to bytes.

**Validation** (auth middleware, L104-158; `resolveJwt`, L327-345; `validateToken`, L296-325):
1. Reject tokens present in the `invalid_auth_token` table (logout).
2. Verify the signature with HS256 only.
3. Load the user with its role. Reject if missing, `disabled`, or the hash doesn't match.
4. Browser-id check (L278-294): for GET requests on the skip-list (push, binary-data, OAuth callbacks, `/types/*.json`, etc.) it is skipped. Otherwise, if the JWT has a `browserId`, the `browser-id` request header must hash to the same value. The frontend sends that header on every request (`frontend/@n8n/rest-api-client/src/utils.ts` L117, L251; `cli/src/server.ts` L180-184).
5. MFA enforcement.
6. Refresh: re-issue the cookie when `exp*1000 - now < jwtRefreshTimeout`. That timeout defaults to 25% of the session duration when `jwtRefreshTimeoutHours` is 0.

Failures clear the cookie and return 401 `{status:'error', message:'Unauthorized'}`.

**Login.** `POST /rest/login` with `{emailOrLdapLoginId, password, mfaCode?, mfaRecoveryCode?}` (`cli/src/controllers/auth.controller.ts` ~L60-90).

All of the JWT, hash and secret derivation can be done with WebCrypto: HMAC-SHA256 with a raw key from `TextEncoder().encode(hexSecret)`, plus SHA-256 and base64url/base64.