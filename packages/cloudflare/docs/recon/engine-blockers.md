I've mapped all six areas. One thing to know up front: `node_modules` isn't installed and `@n8n/tournament@1.0.6` isn't in your local pnpm store, so what I say about tournament's internals comes from my knowledge of that package. Everything else below was read from the repo. Paths are relative to `/Users/admin/.t3/scratch/2026-10-16-hey-i-want-your-help-3fc54a9d/n8n/`.

## 1. Expression evaluation

**Call chain:** `WorkflowExpression.resolveSimpleParameterValue` (`packages/workflow/src/workflow-expression.ts:30-66`) builds a `WorkflowDataProxy` (line 49) and calls `Expression.resolveSimpleParameterValue` (`packages/workflow/src/expression.ts:508-579`). That method:
- Sets `data.process` from `process.arch/env/pid/versions` (525-537).
- Calls `initializeGlobalContext(data)` (314-456). This puts denylisted globals as `{}` and allowlisted ones (Date, DateTime, a safe Object proxy, Math, JSON and so on) on the data object.
- Adds `extend`, `extendOptional`, `__sanitize` and `extendedFunctions`.
- Rejects anything matching `.constructor` with a regex (553).
- Runs `extendSyntax()` (563; `extensions/expression-extension.ts:579`). This only rewrites the AST with esprima-next and recast; nothing is executed.
- Calls `renderExpression` (581-618).

**Two engines, selected by a static field** (`expression.ts:228`, default `'legacy'`):
- **`'legacy'` (default):** `evaluateExpression(expr, data)` in `packages/workflow/src/expression-evaluator-proxy.ts:1-21`.
  - It is `new Tournament(errorHandler, undefined, undefined, {before:[ThisSanitizer], after:[PrototypeSanitizer, DollarSignValidator]})`, and `evaluateExpression` calls `tournament.execute`.
  - The hooks live in `expression-sandboxing.ts`: ThisSanitizer at 137, DollarSignValidator at 248, PrototypeSanitizer at 356, `sanitizer` at 557.
  - Inside tournament (not verifiable here): `getExpressionCode(expr)` turns `{{ }}` templates into a JS function body. Free identifiers become `this.X`, the code is wrapped in try/catch calling `E(err, this)`, and it uses `return`. The default `FunctionEvaluator` then does `new Function('E', code + ';')`, caches it per expression, and calls `fn.call(data, errorHandler)`.
  - The third constructor argument (passed as `undefined` at line 9) is that evaluator class.
  - Tournament also depends on `@n8n_io/riot-tmpl` (pnpm-lock.yaml:27595), which compiles with `new Function` on its own `tmpl()` path. That path should not be hit, but check the dist once it's installed.
  - The error handler is set at `expression.ts:46`: `ExpressionError` is rethrown, everything else is swallowed.
- **`'vm'`:** enabled by `N8N_EXPRESSION_ENGINE=vm` (`packages/@n8n/config/src/configs/expression-engine.config.ts:16`) via `Expression.initExpressionEngine` (`expression.ts:247-272`), which is called from `packages/cli/src/commands/base-command.ts:179`.
  - It uses `@n8n/expression-runtime`, which is **isolated-vm** (`package.json` dependency `isolated-vm ^6.0.2`).
  - `ExpressionEvaluator` (`src/evaluator/expression-evaluator.ts`) calls only `tournament.getExpressionCode()` and caches the result in an LRU. It then calls `IsolatedVmBridge.execute` (`src/bridge/isolated-vm-bridge.ts:527-620`), which wraps the code as `(function(){ code }).call(__data)` and runs `isolate.compileScriptSync` against lazy proxies that call back to the host. `E()` is injected at 264-285.
  - Per-execution acquire/release happens at `packages/core/src/execution-engine/workflow-execute.ts:1443` and `:2318`. In legacy mode these are no-ops.
  - isolated-vm is loaded lazily (`src/index.ts` comment), but `bridge/isolated-vm-bridge.ts:2` imports `node:fs/promises`.
  - `expression.ts:2-3` statically imports error classes from `@n8n/expression-runtime`. The frontend aliases the package to a stub (`packages/frontend/editor-ui/vite.config.mts:30-33`, `vite/expression-runtime-stub.ts`). Reuse that stub.

**Other eval/vm call sites in workflow/core:** the only other one is `packages/core/src/nodes-loader/load-class-in-isolation.ts:2,4,15`. It runs `createContext({ require })` at module top level and `new Script(...)`. Because `core/src/index.ts` re-exports `./nodes-loader`, **importing `n8n-core` evaluates this module**, so alias it or stub `vm`. `Expression.resolveWithoutWorkflow` (458) also goes through `evaluateExpression`.

**Narrowest swap point:** `packages/workflow/src/expression-evaluator-proxy.ts:13`, the `evaluator` constant. Replace it with:
```ts
const cache = new Map<string, Function>();
const evaluator = (expr, data) => {
  let fn = cache.get(expr);
  if (!fn) { const [code] = tournamentEvaluator.getExpressionCode(expr);
             const i = new Sval({ ecmaVer: 'latest', sandBox: true });
             i.run(`exports.f = function (E) {${code}\n}`); fn = i.exports.f; cache.set(expr, fn); }
  return fn.call(data, tournamentEvaluator.errorHandler);
};
```
Why this works:
- It keeps tournament's AST sanitizers, extendSyntax, the global context and error mapping unchanged.
- sval closures can be called from host code, and `this` is the real `WorkflowDataProxy` Proxy.

Alternatives:
- Pass a custom evaluator class as tournament's third constructor argument. Same effect.
- A `SvalBridge implements RuntimeBridge` (`expression-runtime/src/types/bridge.ts`) is possible, but `initExpressionEngine` hardcodes `IsolatedVmBridge`, and the bridge path serializes data for isolate transfer, which you don't need.

Keep `expressionEngine='legacy'`.

## 2. Code node

- `packages/nodes-base/nodes/Code/Code.node.ts:162-204`: JavaScript **always** goes through `JsTaskRunnerSandbox` (`JsTaskRunnerSandbox.ts`), which calls `this.startJob('javascript', {code, nodeMode, workflowMode, continueOnFail, chunk?, additionalProperties}, itemIndex)`.
  - Results are validated by `validateRunCodeAllItems/EachItem` (`result-validation.ts`).
  - Per-item mode runs in chunks of 1000.
- `startJob` → `additionalData.startRunnerTask(...)` (`packages/core/src/execution-engine/node-execution-context/base-execute-context.ts:244-268`; interface at `packages/workflow/src/interfaces.ts:3050-3067`).
  - In the CLI this is `Container.get(TaskRequester).startTask` (`packages/cli/src/workflow-execute-additional-data.ts:502-538`), which sends the task over the broker to a separate `@n8n/task-runner` process.
- **There is no in-process fallback for the Code node.** The old vm2 path (`JavaScriptSandbox.ts`, using vm2 `NodeVM` plus `process.env` at module load) survives only in the legacy `Function` and `FunctionItem` nodes and `@n8n/nodes-langchain/nodes/code/Code.node.ts`.
  - `Sandbox.ts:getSandboxContext` is the in-process context builder: `$getNodeParameter`, `$getWorkflowStaticData`, `helpers`, plus a spread of `getWorkflowDataProxy(index)`.
- In the runner (`packages/@n8n/task-runner/src/js-task-runner/js-task-runner.ts`):
  - It uses `node:vm` (29). `runForAllItems` (343) and `runForEachItem` (404) call `runInContext(createVmExecutableCode(code))` (680-706: freezes and patches globals, then `module.exports = async function VmCodeWrapper(){code}()`).
  - In insecure mode, `runDirectly` (709) uses `new Function('context', 'with(context){...}')`.
  - Context (`buildContext` around 658-675):
    - `require` resolver, custom `console` (only `log` forwards over RPC), `$getWorkflowStaticData`.
    - Native globals (277-296): Buffer, timers, btoa/atob, TextEncoder/TextDecoder plus the stream variants, FormData.
    - A full `WorkflowDataProxy` spread (`createDataProxy` at 500): `$input`, `$json`, `$()`, `$node`, `$items`, `$env`, `$vars`, `$execution`, `$now`, etc.
    - `items` (all-items mode) or `item` (each-item mode), plus `additionalProperties`.
    - RPC helpers (`runner-types.ts:105-126`): `assertBinaryData`, `getBinaryDataBuffer`, `prepareBinaryData`, `setBinaryDataBuffer`, `binaryToString`, `httpRequest`, `request`. Explicitly unsupported (129+): `httpRequestWithAuthentication`, streams, fs.

**Port:** implement `additionalData.startRunnerTask` in-process for `jobType==='javascript'`:
- Context = `executeFunctions.getWorkflowDataProxy(i)` plus `items`/`item`, helpers bound from `executeFunctions.helpers`, `console`, `$getWorkflowStaticData`.
- Run with sval: `exports.p = (async function(){${code}\n})()`, with the context injected via `interpreter.import(ctx)` or wrapped in a `with`.
- Return `{ ok: true, result }`.
- Deep-copy input items, because the runner normally gets serialized copies.
- Implement `getRunnerStatus` as well.

## 3. WorkflowExecute

**Class:** `packages/core/src/execution-engine/workflow-execute.ts`.
- Constructor at 105: `(additionalData, mode, runExecutionData?, storedAt='db')`.
- Entry points, all returning `PCancelable<IRun>`:
  - `run({workflow, startNode?, destinationNode?, pinData?, triggerToStartFrom?})` at 123: full run.
  - `runPartialWorkflow2(workflow, runData, pinData, dirtyNodeNames, destinationNode, agentRequest?)` at 198: manual partial run, via DirectedGraph, findSubgraph, findStartNodes, handleCycles, cleanRunData, recreateNodeExecutionStack.
  - `processRunExecutionData(workflow)` at 1411: resume or pre-built stack.
- How the CLI chooses: `packages/cli/src/manual-execution.service.ts:48-195` (triggerToStartFrom → `processRunExecutionData`; no runData → `run`; otherwise `runPartialWorkflow2`) and `packages/cli/src/workflow-runner.ts:250-312`.
- **Minimal in-process template:** `packages/core/nodes-testing/node-test-harness.ts:200-258` builds a `Workflow` and `ExecutionLifecycleHooks` and runs `processRunExecutionData`.

**additionalData** (`packages/workflow/src/interfaces.ts:3016-3075`, augmented in `packages/core/src/execution-engine/index.ts:27-54`):

| Status | Fields |
|---|---|
| Required | `credentialsHelper` (abstract class at `interfaces.ts:209`: `getParentTypes`, `authenticate`, `preAuthentication`, `getCredentials`, `getDecrypted`, `updateCredentials`, `updateCredentialsOauthTokenData`, `getCredentialsProperties`), `executeWorkflow` (sub-workflows), `getRunExecutionData`, `currentNodeExecutionIndex`, `restApiUrl`, `instanceBaseUrl`, `formWaitingBaseUrl`, `webhookBaseUrl`, `webhookWaitingBaseUrl`, `webhookTestBaseUrl`, `variables`, `logAiEvent`, `startRunnerTask` |
| Effectively required | `hooks` (asserted in `setupExecution`, 1339-1350) |
| Optional | `executionId`, `restartExecutionId` (must be explicitly `undefined` or the before-hook is skipped), `httpRequest`/`httpResponse` (express objects, used by `WebhookContext`), `setExecutionStatus`, `sendDataToUI`, `executionTimeoutTimestamp`, `userId`, `streamingEnabled`, `getRunnerStatus`, `ssrfBridge`, `externalSecretsProxy`, `workflowSettings`, `executionContext` |

The CLI's builder is `getBase()` at `cli/src/workflow-execute-additional-data.ts:~455-560`.

**Hooks** (`packages/core/src/execution-engine/execution-lifecycle-hooks.ts`) and when they fire:
- `workflowExecuteBefore`, or `workflowExecuteResume` if `restartExecutionId` is set: 1454/1456, after `acquireIsolate` and `establishExecutionContext`.
- `nodeExecuteBefore`: 1611.
- `nodeExecuteAfter`: 1902/1964/1979/2090.
- `sendChunk`: 1844.
- `workflowExecuteAfter(fullRunData, newStaticData)`: 2296, and also on cancel (1437) and in `processSuccessExecution` at 2465.
- `sendResponse`: used by RespondToWebhook and webhook triggers.
- `nodeFetchedData`: `request-helper-functions.ts:443`.

**DI services reached at runtime:**
- `ErrorReporter`: `workflow-execute.ts:334,1802,2320`; `requests-response.ts:194`.
- `TriggersAndPollers`: 1110.
- `InstanceSettings`: field initializer at `node-execution-context.ts:55`, so it runs on **every node context**. Only `instanceId` and `hmacSignatureSecret` are used (263, 284).
- `Logger`: `node-execution-context.ts:70`.
- `ExecutionContextService` (→ Logger, ExecutionContextHookRegistry, `Cipher` → InstanceSettings): `execution-context.ts:187` on every run.
- `BinaryDataService`: `utils/binary-helper-functions.ts:47-354`.
- `BinaryDataConfig`: `utils/convert-binary-data.ts:19`.
- `SecurityConfig`/`InstanceSettings`: `file-system-helper-functions.ts:28,58,163,288`.
- `ScheduledTaskManager`: `scheduling-helper-functions.ts`.
- `SSHClientsManager`.
- `Cipher`: `credentials.ts:22`.
- `AiConfig`: `axios-config.ts`.
- `SecurityConfig`: `html-sandbox.ts`.

**Services that touch fs/os/process:**
- `InstanceSettings` (`instance-settings/instance-settings.ts:65-73,160-260`): `existsSync`, `readFileSync`, `mkdirSync`, `writeFileSync` on `~/.n8n/config`, `/proc` reads, `os.hostname`. Replace it with `Container.set(InstanceSettings, stub)` **before** anything resolves it.
- `BinaryDataService.init()`: dynamically imports `FileSystemManager`. If you skip `init()`, `store()` and `getAsBuffer()` fall back to inline base64 (`binary-data.service.ts:97-111,134-142`). Alternatively, `setManager()` with an R2-backed manager.
- `SSHClientsManager`: `process.on('exit')` (66); statically imports `ssh2`.
- `ErrorReporter`: `process.on('uncaughtException')` only in `init()` (124).
- `Logger` (`@n8n/backend-common/src/logging/logger.ts`): imports winston and `node:path`. Use `Container.set(Logger, consoleLogger)` plus `LoggerProxy.init`.
- `@n8n/config` decorators read `process.env` and `readFileSync` for `*_FILE` variables (`packages/@n8n/config/src/decorators.ts:3-25`).
- **`@n8n/di` relies on `reflect-metadata` and `design:paramtypes`** (`packages/@n8n/di/src/di.ts:1,89`). Bundle the tsc-built `dist` output, or use an esbuild plugin that emits decorator metadata (for example swc). Wrangler's esbuild does not emit it, so constructor injection would silently break.

## 4. Heavy dependencies

**packages/workflow (non-test):** value imports are `form-data` and `path` (`utils.ts:4,7`), `callsites` (`errors/base/base.error.ts:2`), plus lodash, luxon, zod, esprima-next, recast, ast-types, `@n8n/tournament`, jmespath, jssha, md5, xml2js, uuid, transliteration, title-case, js-base64 and jsonrepair. All of these are pure JS. Imports of express, fs, http, tls, ssh2, stream, nock, axios, `@sentry/node`, `@langchain/core` and `@codemirror` in `interfaces.ts:2-13`, `node-api.error.ts` and `extensions.ts` are **type-only**. `process.env` is read in `workflow-data-proxy-env-provider.ts:16-19` and `expression.ts:525-537`.

**packages/core (non-test value imports):**
- **Node built-ins:**
  - `node:fs`: storage.config, instance-settings, file-system helpers, binary-data, nodes-loader.
  - `node:os`: instance-settings, file-system helpers.
  - `vm`: load-class-in-isolation.
  - `http`/`https`: http-proxy.ts:1-3, which subclasses `http.Agent` at module top level; also request-helper-functions.ts:23-24 and binary-helper-functions.ts:4.
  - `crypto`, `stream`, `events` (`setMaxListeners`, `workflow-execute.ts:8`), `assert`, `url`, `path`.
- **Third-party:**
  - `ssh2` (`ssh-clients-manager.ts:6`, reached statically from every execute context via `ssh-tunnel-helper-functions.ts`).
  - `cron` (`scheduled-task-manager.ts:5`).
  - `axios`, `form-data` (Node streams), `http-proxy-agent`, `https-proxy-agent`, `proxy-from-env`.
  - `@n8n/client-oauth2`: top-level `new https.Agent` at `client-oauth2.ts:51`; also uses `querystring` and axios.
  - `oauth-1.0a`, `jsonwebtoken`, `file-type`, `chardet`, `iconv-lite`, `fast-glob`, `@aws-sdk/client-s3` (object store).
  - `@langchain/core/tools` (`create-node-as-tool.ts:1`, `get-input-connection-data.ts:2`).
  - `@sentry/*`: dynamic imports in error-reporter.
  - `p-cancelable`, `winston` (via backend-common).
- **Recommended aliases/stubs:** `vm`, `ssh2`, `@n8n/expression-runtime`, `isolated-vm`, `@sentry/*`, `@aws-sdk/client-s3`, `fast-glob`, and `jsdom` (see below).

**Node loading:**
- `LazyPackageDirectoryLoader` (`packages/core/src/nodes-loader/lazy-package-directory-loader.ts`) reads `dist/known/nodes.json`, `known/credentials.json` and `types/*.json`.
- `DirectoryLoader.getNode` (`directory-loader.ts:239-246`) → `loadNodeFromFile` → `loadClassInIsolation` (vm `Script` + `require`, 147-151). It also uses `realpathSync` (96) and `module.require` for codex files (347).
- The CLI's `NodeTypes.getByNameAndVersion` (`packages/cli/src/node-types.ts:65-82`) sits on top of `LoadNodesAndCredentials`. The metadata is generated at build time by `n8n-generate-metadata` (core bin).
- **For Workers:** skip all of this. Write a static `INodeTypes` (getByName, getByNameAndVersion via `NodeHelpers.getVersionedNodeType`, getKnownTypes) over an explicit import map. The pattern is in `packages/core/test/helpers/index.ts:26-50`.

**Most-used nodes** (`packages/nodes-base/nodes/...`):

| Node | Status / problematic imports |
|---|---|
| Set, If, Switch, Filter, Transform (SplitOut/Aggregate/Sort/Limit/RemoveDuplicates), NoOp, ManualTrigger, SplitInBatches, ExecutionData, StopAndError, Xml | Clean: n8n-workflow, lodash, moment-timezone (If/Filter V1), xml2js |
| DateTime | luxon and moment-timezone. Fine |
| Code | `@n8n/di` `NodesConfig` (Python only), JsTaskRunnerSandbox. Needs `startRunnerTask` (section 2) |
| **HttpRequest V3** | `HttpRequestV3.node.ts:48` statically imports `shared/optimizeResponse.ts:1-4` → **jsdom 23** (vm/fs/net), `@mozilla/readability`, `cheerio@1.0.0-rc.6`, `html-to-text`. `GenericFunctions.ts:1` imports `form-data`. Uses `requestOptions.useStream = true` (507/510), and the legacy `helpers.request`/`requestWithAuthentication`/`requestOAuth2` paths (685-736). Stub jsdom or lazy-load optimizeResponse |
| Merge v3 | `helpers/sandbox-utils.ts:1-2` uses `node:fs/promises` and `node:crypto` statically; `isolated-vm` is a dynamic import (14). Only "combine by SQL" breaks |
| **Webhook** | `Webhook.node.ts:2,15`: `fs.createWriteStream` + `tmp-promise` (the binary-upload path at 323-345), `isbot`. `utils.ts`: `basic-auth`, `jsonwebtoken`, `node:crypto`, `node:net` `BlockList` (15). Also relies on express `req`/`res` and `req.readRawBody` |
| RespondToWebhook | `jsonwebtoken`; responds via `this.sendResponse` (575) → `sendResponse` hook |
| ScheduleTrigger | `cron` (`sendAt`), moment-timezone |
| Wait | Pure; calls `putExecutionToWait` |
| Crypto v2 | `crypto` `createHash/createHmac/createSign/getHashes/randomBytes`. **`getHashes()` runs at module load (line 27).** Also `stream/promises` |
| ExecuteWorkflow | `fs/promises` (`GenericFunctions.ts:1`, "local file" source) plus `additionalData.executeWorkflow` |
| Slack V2 | moment-timezone, crypto. Fine |
| Gmail | `mailparser` and `nodemailer/lib/mail-composer` (`Google/Gmail/GenericFunctions.ts:3,18`). Risky (nodemailer internals pull net/dns/os) |
| Postgres | `pg-promise` plus `node:net` `createServer` for SSH tunnels (`transport/index.ts:8-9,131`). Needs Hyperdrive/`cloudflare:sockets`-compatible `pg` |
| nodes-base `utils/binary.ts` | `xlsx`, `iconv-lite`, dynamic `pdfjs-dist`. `utils/sendAndWait/utils.ts` imports n8n-core + Form node |

## 5. HTTP requests

All of this is in `packages/core/src/execution-engine/node-execution-context/utils/request-helper-functions.ts`.

**The two request paths:**
- `helpers.httpRequest` → `httpRequest()` (661) → `convertN8nRequestToAxios` (506-631) → `invokeAxios` (90, which handles the digest-auth retry) → `axios(config)`.
- The legacy `helpers.request` → `proxyRequestToAxios` (413-500) → `parseRequestObject` (118-410, a request-library → axios mapping including `formData` via `form-data`).

**Authenticated wrappers:** `httpRequestWithAuthentication` (1047), `requestWithAuthentication` (1163), `requestOAuth2` (795, via `@n8n/client-oauth2`'s own axios plus `https.Agent`), `requestOAuth1` (934). Pagination is in `getRequestHelperFunctions` (1270+).

**Transport specifics:**
- axios is pinned to **1.13.5** (`pnpm-workspace.yaml:53`), so the fetch adapter exists.
- No adapter is set, so the Node `http` adapter (follow-redirects) is used today.
- Global defaults and interceptor live in `request-helpers/axios-config.ts:11-37`: timeout 300s, `proxy=false`, qs serializer, an interceptor that calls `setAxiosAgents` and adds OpenAI headers.
- `setAxiosAgents` (`axios-utils.ts:277-299`) creates per-request `http(s).Agent`s or `Http(s)ProxyAgent`s (`packages/core/src/http-proxy.ts:120-160`) with `servername`, `rejectUnauthorized` and the SSRF `lookup`.
- `getBeforeRedirectFn` (`axios-utils.ts:~80-135`) is a follow-redirects hook that re-applies agents and auth headers.
- Responses: `responseType:'stream'` when `useStream` is set (364-366), checked with `instanceof IncomingMessage` (441) and `instanceof Readable` (469, 1390, 1498). `'arraybuffer'` when `encoding: null`.
- `form-data` bodies use `body.getHeaders()` (575) and `getLength` (`axios-utils.ts:~230`).

**What switching to fetch takes:**
1. Set `axios.defaults.adapter = 'fetch'` in `axios-config.ts`. Also bundle axios's browser build, or make sure the `http` adapter isn't selected; XHR doesn't exist in Workers.
2. Make `setAxiosAgents` and `getBeforeRedirectFn` no-ops. Agents, `servername`, `rejectUnauthorized`, proxies and the SSRF `lookup` can't be expressed through fetch. `maxRedirects: 0` must become `fetchOptions: { redirect: 'manual' }`.
3. Convert `form-data` (a Node CombinedStream) to native `FormData`/`Blob` in `createFormDataObject` and the 160-226 branches of `parseRequestObject`, or in an interceptor.
4. For streams, the fetch adapter returns a web `ReadableStream`. Map `responseType:'stream'` → `Readable.fromWeb(...)`, or force `'arraybuffer'` and wrap with `Buffer.from`. That keeps the `IncomingMessage`/`Readable` checks and `parseIncomingMessage` working; otherwise `content-disposition` parsing breaks.
5. Patch `@n8n/client-oauth2` the same way (its module-level `https.Agent` must at least construct without throwing).

## 6. Triggers, polls, webhooks, Wait

**Triggers and pollers:**
- `ActiveWorkflows.add` (`packages/core/src/execution-engine/active-workflows.ts:70-138`) calls `TriggersAndPollers.runTrigger` (`triggers-and-pollers.ts:26-90`) for each trigger node.
  - In manual mode it wraps `emit` into a promise and registers `sendResponse`/`workflowExecuteAfter` handlers on the hooks.
- For poll nodes, `activatePolling` (141-176) runs a test poll, then calls `ScheduledTaskManager.registerCron` (`scheduled-task-manager.ts:47-100`, using `cron.CronJob` with an `isLeader` gate) for each `pollTimes` expression.
- ScheduleTrigger (`nodes/Schedule/ScheduleTrigger.node.ts:427-508`) calls `this.helpers.registerCron` (`scheduling-helper-functions.ts` → `ScheduledTaskManager`); in manual mode it returns `manualTriggerFunction`.
- The CLI's `ActiveWorkflowManager.getExecuteTriggerFunctions`/`getExecutePollFunctions` (`packages/cli/src/active-workflow-manager.ts:299-445`) override `emit` to call `workflowExecutionService.runWorkflow`.

**Port for triggers:** `Container.set(ScheduledTaskManager, impl)`, where `registerCron` records `{expression, onTick}` into a Durable Object alarm or Cron Trigger. On each alarm, rebuild the trigger context, run `trigger()`, and invoke the captured `onTick`. That calls `emit`, which starts a `WorkflowExecute`.

**Webhooks:**
- `LiveWebhooks.executeWebhook` (`packages/cli/src/webhooks/live-webhooks.ts:71`) → `webhook-helpers.ts:executeWebhook` (414+).
  - Body parsing in `parseRequestBody` (1027).
  - `WebhookService.runWebhook` (`webhook.service.ts:437-466`) builds a `WebhookContext`, whose `getRequestObject`/`getResponseObject` read `additionalData.httpRequest`/`httpResponse` (`webhook-context.ts:85-110`, which expect express types).
  - Then `prepareExecutionData` (348) puts the webhook node and its output on the stack and runs it.
  - In `responseNode` mode, `setupResponseNodePromise` (300) resolves via the `sendResponse` hook.
- **Port for webhooks:** provide minimal express-like `req` (`body`, `headers`, `query`, `params`, `rawBody`, `readRawBody`) and `res` shims.

**Wait:**
- `Wait.node.ts:508-632` computes `waitTill`, either a date or `WAIT_INDEFINITELY` for webhook/form resume. It calls `context.putExecutionToWait(waitTill)` (`base-execute-context.ts:107-108`: `runExecutionData.waitTill = waitTill`) and returns its input.
- WorkflowExecute stops when `waitTill` is set (1782, 1834, 1963). `processSuccessExecution` (2413-2458) sets `fullRunData.waitTill` and status `waiting`.
- Resume:
  - The CLI's `WaitTracker` polls the DB every 5s and uses `setTimeout` (`packages/cli/src/wait-tracker.ts:53-60, 64-130`). It then calls `workflowRunner.run` with the stored `executionData`, which leads to `new WorkflowExecute(ad, mode, executionData).processRunExecutionData(workflow)` (`workflow-runner.ts:304-312`) with `restartExecutionId` set.
  - `handleWaitingState` (`workflow-execute.ts:1293-1310`) disables the waiting node on the stack and pops its last run.
  - Webhook/form resumes go through `packages/cli/src/webhooks/waiting-webhooks.ts`.
- **Port for Wait:** persist `IRun.data` (DO storage or D1) on `workflowExecuteAfter` when `waitTill` is set, schedule a DO alarm at `waitTill`, then resume as above.

## Porting checklist (priority order)
1. Bundle from tsc `dist` (so decorator metadata survives). Alias `vm`, `ssh2`, `@n8n/expression-runtime`, `isolated-vm`, `jsdom`, `@sentry/*`, `@aws-sdk/client-s3`, `fast-glob` and `tmp-promise` to stubs.
2. Before importing node classes, call `Container.set` for `InstanceSettings` (stub with `instanceId`, `encryptionKey`, `hmacSignatureSecret`, `n8nFolder`), `Logger`, `ErrorReporter`, `ScheduledTaskManager` and `BinaryDataService` (don't `init()` it, or give it an R2 manager).
3. Swap the evaluator at `expression-evaluator-proxy.ts:13` to sval.
4. Implement an in-process `startRunnerTask` using sval.
5. Switch axios to the fetch adapter and patch `setAxiosAgents`, form-data and stream handling.
6. Write a static `INodeTypes`, your own `additionalData` and hooks (using node-test-harness as the template), and DO-based cron, wait and webhook plumbing.

Things to check once dependencies are installed:
- **Tournament:** confirm the evaluator-class constructor argument and that `new Function` is only in `FunctionEvaluator` and riot-tmpl.
- **sval:** confirm its dist has no `new Function`.
- **workerd modules:** confirm workerd's `node:crypto` `getHashes`/`createSign` and `node:http` `Agent` behave as nodes-base expects.