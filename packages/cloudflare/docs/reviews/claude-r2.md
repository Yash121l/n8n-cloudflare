# Review round 2 (Claude Opus, 2026-10-17)

Round 1 verdicts: 26 fixed, 3 partly fixed (#13, #20, #25), none regressed. 20 new findings. Owners: O = orchestrator, R = runtime agent, S = API agent.

| # | Sev | Finding | Where | Owner |
|---|---|---|---|---|
| 1 | high | Binary view/download logs the user out: browser-id exemption regex needs a trailing slash the route lacks. Fix `/^\/rest\/binary-data(\/|$)/` + test that logs in with browser-id then fetches without it. | src/auth/middleware.ts:47 | O |
| 2 | high | Resumed runs spin alarms (past due pending entry kept); after ctx.abort mid-resume the row stays `running` forever. Fix: after the claim write `{kind:'run'}` as pending. | src/execution/execution-runner.ts:184-206, 275-283 | R |
| 3 | high | Failing poll retries every 10 s forever (runPoll throws before occurrence saved). Treat poll error as handled occurrence like stock poll-trigger-task-handler: error workflow, advance nextFire; 10 s retry only for handoff failures. | src/triggers/trigger-scheduler.ts:185-189, 222-225 | R |
| 4 | high (latent, single user today) | /credentials/test lets a credential:read user send stored secrets to a URL they pick. Stock: reject type mismatch; without credential:update test only stored data. | src/api/routes/credentials.ts:153-186 | S |
| 5 | med-high | Child stopped while waiting resumes parent as success; stop does not notify parent. Write cancellation error into stopped execution data, notify parent runner. | src/runtime/service.ts:242-256, src/execution/runner.ts:893-911 | R |
| 6 | med | Pre-engine failures (credential refused, missing node type) end as `crashed`, no data, no error workflow, webhook 500, parent gets generic error. Build a failed IRun (FailedRunFactory), run hooks, return it. | runner.ts:492-510, execution-runner.ts:238-247 | R |
| 7 | med | Gap between accept and execute: stop lost, alarm marks crashed, ensureVersion may abort in-flight webhook. Register in accept; ensureVersion checks accepting + pending run; do not start engine if `running` update changed no row. | execution-runner.ts:71-118 | R |
| 8 | med-low | Alarm vs webhook resume race on a webhook Wait with time limit. Skip ids in running/accepting; delete pending only if unchanged. | execution-runner.ts:73,192-201, waiting-webhooks.ts:169-177 | R |
| 9 | med | No login rate limit (stock: 5/min per email, 1000/5 min per IP). | src/api/routes/auth.ts:40 | S |
| 10 | med | Pruning hard-deletes at most 9,600/day. Loop batches within a budget. | src/execution/store.ts:134,160-172 | R |
| 11 | low | `POST /executions/delete` with only `filters` deletes everything. Require ids or deleteBefore like stock. | src/api/routes/executions.ts:278-299 | S |
| 12 | low | Webhook binary responses held in memory. Stream. | src/webhooks/response.ts:147-168, execute.ts:337 | R |
| 13 | low | Silent sval fallback when LOADER missing. Fail closed. | src/runtime/code-runner.ts:332-345 | O |
| 14 | low | Expressions run in main isolate (stock legacy engine). Defense in depth only. | | later |
| 15 | low | Resume overwrites startedAt. | runner.ts:458 | R |
| 16 | low | Failed R2 snapshot write turns success into crashed and skips notifyParent. | execution-runner.ts:216,238 | R |
| 17 | low | configure() can race a running alarm. | trigger-scheduler.ts:54-87,202-203 | R |
| 18 | low | Parent of a crashed-without-data child re-checks every 60 s forever. Backoff/cap. | execution-runner.ts:175-181 | R |
| 19 | low | Check owner count before applying 0004 (already applied in production with one owner). | | O (done) |
| 20 | low | binary/temp keys never pruned; restoreBinaryDataId not ported. | | R |

Also from round 1 partials: #13 (stop before register, see 7 and 5), #20 (see 12), #25 (see 1). Test gaps: #7 stale alarm test, #8 durable child timed resume with a wait over 65 s, #24 CAS test bypassed by checksum precheck.
