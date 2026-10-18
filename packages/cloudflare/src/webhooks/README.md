# Webhooks and triggers on Workers

The Hono sub-app exports `webhookRoutes` from `routes.ts`. It is not mounted by this change.
Migration `0005_execution_occurrences.sql` adds the occurrence key that makes scheduler handoffs idempotent.

The implementation ports these stock services:

- `/webhook/*`: `LiveWebhooks`, `WebhookService`, and `WebhookHelpers.executeWebhook`.
  Routing tries static paths first, then dynamic templates by webhook ID and segment count.
  Production runs use the active history revision when `activeVersionId` is set.
- `/webhook-test/*`: `TestWebhooks`. Registrations expire after two minutes. A Durable Object
  alarm deletes expired registrations and calls external webhook delete methods. Test calls
  use manual mode, preserve the push reference, and send `testWebhookReceived`. Cancellation
  sends `testWebhookDeleted`.
- `/webhook-waiting/:executionId[/suffix]`: `WaitingWebhooks`. Resumption requires a waiting
  execution and a matching restart webhook. Ordinary resume URLs use the saved opaque token.
  Send-and-wait URLs use the core HMAC validator. The signature is removed from node input.
  A conditional D1 update prevents concurrent requests from resuming the same execution twice.
- `/form/*`, `/form-test/*`, and `/form-waiting/*`: the same services with form node matching.
  GET requests call the node's webhook method to render a page. POST requests accept multipart
  submissions. Multi-page forms, Wait forms, status polls, and completion views use saved run data.
- `activateWorkflow` and `deactivateWorkflow`: the webhook, schedule, and polling parts of
  `ActiveWorkflowManager`, `ActiveWorkflowTriggers`, and `TriggersAndPollers`.
  Schedule Trigger and Cron callbacks register through a supplied `TriggerContext` scheduler.
  Polling uses `PollContext`, seeds its cursor on activation, and persists static data in D1.

Every webhook execution runs in the `ExecutionRunner` Durable Object of its workflow.
`onReceived` starts the run there and answers at once. Other response modes forward the HTTP
request to the runner (`executeOwnedWebhookTail`). The runner installs the HTTP response and the
`sendResponse` hook, so Respond to Webhook answers when the node runs while later nodes continue.
`lastNode` answers when the run ends. A stop request reaches the engine through the runner.
Responses support status, headers, JSON selection, binary data, and no body. Stored binary data
and node streams go to the caller as a stream, so the runner does not hold the body in memory.
In `streaming` mode the runner answers at once with a body stream. The `sendChunk` hook writes each
chunk as one JSON line, as stock does, and a `{"type":"keepalive"}` line goes out every 30 seconds.
The stream ends when the run ends. The runner sets `Content-Encoding: identity` on the stream,
because edge compression buffers the body. The Chat Trigger serves its hosted chat page, streams
replies, and gets the `hostedChat` answer (`executionStarted`) in `responseNodes` mode. Its execution
data exists before the node runs, as in stock, so the node can store custom data.

Every response of a webhook or form route gets the stock sandbox CSP, including error responses.
The sandbox replaces a CSP that the workflow sets. When an operator disables sandboxing
(`N8N_INSECURE_DISABLE_WEBHOOK_IFRAME_SANDBOX`, `N8N_INSECURE_DISABLE_FORM_IFRAME_SANDBOX`),
the headers stay as the workflow sets them.

A run that suspends at a timed Wait resumes from a runner alarm. A webhook resume claims the
waiting execution in D1 and then hands the request to the runner. The claim makes sure that only
one resume runs.

The request adapter supports JSON, URL-encoded fields, text, binary bodies, repeated query values,
and multipart files. It keeps raw bytes in a Buffer and limits request bodies to 16 MiB. Multipart
file data stays in memory. A node receives a temporary path and an overridden `copyBinaryFile`
helper, so the stock node can copy and remove its upload without a host filesystem dependency.
The helper stores the upload in R2 like stock does. The execution has no ID yet, so the file goes
under `temp`. When the run ends or waits, `restoreBinaryDataId` moves it to the execution ID. The
cron prune deletes `temp` files that are older than the hard-delete buffer and older than every
execution in progress.
The adapter strips n8n login cookies from ordinary webhook input, as the stock sanitizer does.

The form templates are stock Handlebars templates from `packages/cli/templates`. Their compiled
functions and the Handlebars runtime are bundled in `templates.js`. There is no runtime template
file read, template compilation, or dynamic code generation. Regenerate them after a template change:

```sh
node src/webhooks/generate-templates.mjs
```

Persistent-process triggers are rejected with a `WorkflowActivationError` that names the node.
Manual and sub-workflow entry nodes do not register production triggers. Other `trigger()` nodes
outside Schedule Trigger and Cron are rejected instead of starting timers or connections.

The scheduler skips missed occurrences, like stock cron. Stock registers a `CronJob` that
computes the next fire from the current time and never replays fires missed while the process was
down. A late alarm (after downtime or a delayed delivery) fires the overdue occurrence once, as a
late stock timer does. The next fire is then computed from the current time. For each due occurrence it first stores
the trigger output in Durable Object storage. Then it creates the executions with an occurrence
key (unique in D1) and hands them to the runner. It advances `nextFire` only after the runner
accepts every execution. A failed handoff retries after 10 seconds with the stored output, and the
occurrence key makes a repeated handoff a no-op. A poll that throws is a handled occurrence, as in
stock `PollTriggerTaskHandler`: the scheduler saves a failed `trigger` execution, runs the error
workflow, keeps the poll cursor, and advances the schedule. Each due schedule is handled on its own,
so one failing schedule does not hold back the others.
Third-party webhook registration and send-and-wait HMAC validation use stock contexts and helpers,
but the integration tests do not contact third-party services. First-party n8n OAuth and user-auth
forms still require the identity callbacks that the shared runtime does not currently supply.

Mount the routes in `src/api/app.ts`, inside `createApp`, outside the authenticated REST sub-app:

```diff
+import { webhookRoutes } from '../webhooks/routes';
@@
 export function createApp() {
   const app = new Hono<AppEnv>();
+  app.route('/', webhookRoutes);
```

Alternatively mount them in `src/index.ts`:

```diff
+import { webhookRoutes } from './webhooks/routes';
@@
 const app = createApp();
+app.route('/', webhookRoutes);
```

Stock 2.44 cancellation is `DELETE /rest/test-webhook/:workflowId`, defined in
`packages/cli/src/webhooks/test-webhooks.controller.ts`. Replace the existing direct SQL deletion
in `src/api/routes/workflows.ts` so cancellation also deletes external registrations and sends push:

```diff
+import { cancelTestWebhook } from '../../webhooks/test-webhooks';
@@
 workflowRoutes.delete('/test-webhook/:workflowId', async (c) => {
-  requireUser(c);
-  await c.env.DB.prepare('DELETE FROM test_webhook WHERE workflowId = ?').bind(c.req.param('workflowId')).run();
+  const user = requireUser(c);
+  const workflowId = c.req.param('workflowId');
+  await requireWorkflow(c.env.DB, user, workflowId, 'workflow:execute');
+  await cancelTestWebhook(c.env, workflowId);
   return ok(c, true);
 });
```

The integration suite uses its own built worker entry with test-only registration and inspection
routes. Those routes are not part of the production entry. Run it from `packages/cloudflare`:

```sh
pnpm exec vitest run --config vitest.webhooks.config.ts
```

The default `vitest.config.ts` currently includes every test directory. Exclude these suites there,
because they need their own worker entry and global setup:

```diff
-import { defineConfig } from 'vitest/config';
+import { configDefaults, defineConfig } from 'vitest/config';
@@
 test: {
+  exclude: [...configDefaults.exclude, 'test/webhooks/**', 'test/triggers/**'],
```

The tests reuse `test/api/harness.ts` and the local D1 helpers. They build with `build.mjs`, apply
the real migrations, and run through Wrangler's `unstable_startWorker`. Schedule, expiry, and
polling tests use actual Durable Object alarms. Polling reads a local RSS fixture and can wait
up to one minute for the next tick. No direct alarm invocation or remote service is needed.

A cold activation with Webhook and Wait hung while the runtime loaded both node modules with
`Promise.all`. Serial loading in the webhook boundary passed the same test. Apply that order in
`src/runtime/node-types.ts` too, so a durable execution in a fresh isolate has the same protection:

```diff
@@
 const types = new Set(workflow.nodes.map((node) => node.type));
-const nodeTypes = await Promise.all([...types].filter(isKnownNodeType).map(loadNodeType));
+const nodeTypes: Array<INodeType | IVersionedNodeType> = [];
+for (const type of types) {
+  if (isKnownNodeType(type)) nodeTypes.push(await loadNodeType(type));
+}
```

Verification on 2026-10-17:

```text
node build.mjs src/index.ts dist/worker       exit 0
pnpm typecheck                              exit 0
npx vitest run --config vitest.webhooks.config.ts --maxWorkers=2

Test Files  4 passed (4)
     Tests  55 passed (55)
  Duration  62.49s
```
