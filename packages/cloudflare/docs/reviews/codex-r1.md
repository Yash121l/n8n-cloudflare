# Codex review, round 1 (2026-10-17)

Findings from a read-only review by Codex GPT-6.1-Sol. Paths are relative to `packages/cloudflare`. Status column: who fixes it.

| # | Sev | Finding | Where | Owner |
|---|---|---|---|---|
| 1 | critical | Code nodes can read the encryption key: sval `sandBox` global inherits host `process`; bootstrap put the key in `process.env`. Host `JSON` is mutable from user code. | src/runtime/code-runner.ts | Mitigated by orchestrator (key removed from process.env after bootstrap, host globals shadowed, test/runtime/code-sandbox.test.ts). Full fix: Dynamic Workers sandbox (agent D) |
| 2 | critical | Unrelated users get workflow-owner permissions: every sharing row contributes scopes even without project membership. Reproduced GET+PATCH 200 on another user's workflow. | src/api/workflow-view.ts:28 | A |
| 3 | high | Project viewers inherit credential update/delete: resource and project scopes are unioned instead of intersected. | src/auth/scopes.ts:47 | A |
| 4 | high | Executions and dynamic dropdowns can use unshared credentials: credentials fetched by id+type only, no permission check (stock: CredentialsPermissionChecker). | src/runtime/credentials-helper.ts:192, service.ts | C |
| 5 | high | Webhook HTML responses lack stock's sandbox CSP header. | src/webhooks/response.ts:141 | B |
| 6 | high | Concurrent owner setup creates multiple owners (check and insert not atomic). | src/api/routes/auth.ts:81 | A |
| 7 | high | Stale runner alarms resume later waits early (no claim of waiting state/deadline). | src/execution/execution-runner.ts | Fixed by orchestrator (atomic claim on status+waitTill) |
| 8 | high | Waiting sub-workflows cannot complete their parent's lifecycle (children inline, no durable runner/request, no parent resume). | src/execution/runner.ts:427 | B |
| 9 | high | Sub-workflow caller policies (callerPolicy, callerIds) ignored. Port SubworkflowPolicyChecker. | src/execution/runner.ts:394 | B |
| 10 | high | Production sub-workflows run unpublished drafts; must use published version by root mode, reject unpublished like stock. | src/execution/runner.ts:397 | B |
| 11 | high | Workflows whose only trigger is Execute Workflow Trigger cannot be published (400). | src/triggers/activation.ts:23 | B |
| 12 | high | Respond to Webhook waits for downstream nodes before returning the HTTP response. | src/webhooks/execute.ts:244 | B |
| 13 | high | Stopping inline (webhook/child) executions only flips DB status; runner had a pre-onStart cancel gap. | src/runtime/service.ts:208 | Runner part fixed by orchestrator; inline webhook/child cancellation: B |
| 14 | high | Saving Multiple Headers Auth overwrites secrets: redaction restore skips arrays. | src/api/credential-redaction.ts:108 | A |
| 15 | high | Executions get variables from every project (`SELECT key, value FROM variables` unfiltered). Load global + owning project, project overrides global. | src/execution/runner.ts:117 | B |
| 16 | high | Scheduler advances nextFire in `finally` even when handoff fails, losing occurrences. | src/triggers/trigger-scheduler.ts:203 | B |
| 17 | high | Workflow `executionTimeout` not enforced; `executionTimeoutTimestamp` never set. | src/execution/runner.ts:165 | B |
| 18 | high | Save preferences (saveDataSuccessExecution, saveDataErrorExecution, saveManualExecutions) ignored; settings advertise pruning but none exists. | src/execution/runner.ts:255 | B |
| 19 | high (plausible) | Detached execute() without waitUntil in the runner DO. | src/execution/execution-runner.ts:28 | Fixed by orchestrator (ctx.waitUntil) |
| 20 | high (plausible) | R2 byte store buffers whole objects; large binaries can exceed 128 MB. | src/runtime/r2-byte-store.ts:44 | C |
| 21 | medium | Configured Error Workflows never run. Port stock error-workflow dispatch. | src/execution/runner.ts:245 | B |
| 22 | medium | Deleting a workflow orphans its R2 execution data. | src/db/workflows.ts:332 | A |
| 23 | medium | Parent outputs keep child-owned binary IDs (stock duplicates binaries to parent). | src/execution/runner.ts:448 | B |
| 24 | medium | Checksum check does not prevent concurrent lost saves; needs atomic compare-and-swap. | src/db/workflows.ts:279 | A |
| 25 | medium | No `/rest/binary-data` route; editor cannot view/download binaries. | src/api/app.ts | C |
| 26 | medium | OAuth1/OAuth2 credential connect flow not implemented (`/rest/oauth2-credential/auth`, callbacks). | src/api/app.ts | C |
| 27 | medium | Declarative dynamic dropdowns (loadOptions routing without methodName) always throw. Port getOptionsViaLoadOptionsByPath / getOptionsViaLoadOptions. | src/runtime/service.ts:332 | C |
| 28 | medium | Any authenticated user can cancel another workflow's test listener (no scope check). | src/api/routes/workflows.ts:312 | A |
| 29 | low | Push origin validation accepts missing/non-HTTP origins. | src/api/routes/push.ts:12 | A |

Looked solid: JWT verification, credential encryption and top-level redaction, SQL bindings, webhook routing and resume-token validation, manual execution + partial execution delegation to core.
