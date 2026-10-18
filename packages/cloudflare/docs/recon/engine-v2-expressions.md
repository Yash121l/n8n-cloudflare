I read through all four areas. The two answers that shape the port most:

- **Engine v2 can't serve production yet.** It is a pre-release scaffold behind a module flag. It also refuses to run when expressions use the legacy `new Function` engine.
- **There is a one-argument seam for an eval-free interpreter.** Tournament takes a pluggable evaluator class, and swapping it in keeps the real WorkflowDataProxy and the host `extend()` functions.

Paths below are relative to `n8n-cf/packages/`. Nothing was executed and the repo has no build output, so the generated code in section 3 was worked out by hand from the builder source.

---

## 1. `@n8n/engine` (engine v2) and `@n8n/node-engine-compatibility`

**What it is.** A new data-plane execution engine. `@n8n/engine/README.md` says it "is currently a scaffold and is not yet wired into n8n". `AGENTS.md` describes the design: a pure core in `graph/`, `execution/` and `admittance/`, with every effect injected as an interface. `@n8n/node-engine-compatibility` adapts v1 nodes and workflows to it: `v1-workflow-converter.ts` turns a workflow into a graph, and `V1StepExecutor` in `v1-step-executor.ts` runs a v1 node as one step.

**Is it on in production?** No. It is off by default and needs two opt-ins:
- **Module flag.** `N8N_ENABLED_MODULES=engine-v2` (`cli/src/modules/engine-v2/engine-v2.module.ts:13-24`). It is main-only and throws in queue mode (`:31-33`).
- **Per-workflow setting.** `workflowData.settings.engineType === 'v2'` (`workflow/src/interfaces.ts:4118`, checked in `cli/src/services/engine-v2-dispatcher.service.ts:96`). Only the `manual`, `webhook` and `trigger` modes route there (`:42`). The call site is `cli/src/workflow-runner.ts:126`.

**Config.** `@n8n/config/src/configs/engine.config.ts`:
- `N8N_ENGINE_MODE` defaults to `in-process`; `remote` means a separate `n8n engine` process (`cli/src/commands/engine.ts`).
- `N8N_ENGINE_DATABASE_URL` defaults to empty, which means healthcheck-only mode. It is marked "in development and not ready for use" (`:51-59`).
- Also: `N8N_ENGINE_AUTH_SECRET`, `N8N_ENGINE_PORT`/`HOST` (3000), `N8N_ENGINE_CONTROL_PLANE_PORT` (3001), `N8N_ENGINE_WEBHOOK_RESPONSE_TIMEOUT`.

**Gaps in v2 today.** `cli/src/modules/engine-v2/engine-additional-data.ts:120-125` stubs these as unimplemented: `startRunnerTask` (so the Code node does not work on v2), `executeWorkflow` (sub-workflows), agents and runtime credentials. `V1StepExecutor` also rejects "wait indefinitely" and wait-for-sub-execution (`v1-step-executor.ts:61-67`).

**Architecture** (wired up in `@n8n/engine/src/runtime/create-engine-runtime.ts:73-159`):
- **Step model.** `graph/workflow-graph.ts`:
  - The graph is `{nodes, edges}`, and back-edges are allowed for loops.
  - `StepType` is one of `'trigger' | 'v1-node' | 'wait' | 'subworkflow' | 'batch'` (`:7`).
  - A step is identified by `nodeId@iteration` (`execution/execution.types.ts:184-194`).
  - Step data is `StepSlots = JsonValue[]`, one entry per output or input slot. It is JSON round-tripped and stored in a `jsonb` column (`execution.types.ts:92`).
  - A step either returns `{outputs}` or `{wait: WaitDeclaration}`. A wait carries `resumeAt` plus the outputs to emit at the deadline, and/or `acceptsResumeRequest` (`:134-148`).
  - Non-native steps go through `IStepExecutor.execute(request)` (`dependencies/external-dependencies.ts:87-89`).
- **Queue.** `queue/work-queue.types.ts`. There are two logical queues:
  - Orchestration queue: `execution:enqueued`, `step:settled`.
  - Step queue: `step:ready`.
  - Messages carry ids only. The only implementation is `InMemoryWorkQueue`, and work is lost on restart (`create-engine-runtime.ts:82-83`, `:147-150`).
  - Flow: `StepReadyHandler` claims the step, runs it and publishes `step:settled`. `StepSettledHandler` plans the successors, calls `createSteps` and publishes `step:ready`.
  - `WaitSweeper` polls on an interval (default 1 minute) for waits whose deadline has passed.
- **Response channel.** `response-channel/execution-response.types.ts`:
  - Messages are `response`, `chunk`, `ended` and `undeliverable`.
  - The caller's expectation is one of `none`, `runEnd`, `stepResponse`, `stream`.
  - The CLI implements it in memory for in-process mode and over Redis pub/sub for remote mode (`cli/src/modules/engine-v2/response-channel/*`).
  - It is at-most-once.
- **Database.** TypeORM, Postgres only (`database/data-source.ts:17-28`, `type: 'postgres'`). There are three tables (workflow execution, step execution, seeded step). The wait sweeper uses `FOR UPDATE SKIP LOCKED` (`typeorm-step-store.ts:224`).
  - There are no cross-store transactions. A crash mid-sequence is meant to be fixed later by a reconciliation pass (AGENTS.md, "Crash recovery").
  - `engine-step-data-loader.ts` loads the whole graph and every completed step's outputs on every step.
- **Dependencies** (`@n8n/engine/package.json`): express, jsonwebtoken, pg, `@n8n/typeorm`, zod, uuid, `@n8n/config`/`di`. There is no pg-boss, isolated-vm or worker_threads. The compatibility package pulls in `n8n-core` and `n8n-workflow`.
- **Hard requirement on the expression engine.** `V1StepExecutor.validateExpressionEngine()` (`v1-step-executor.ts:94, 129-134`) throws `VmExpressionEngineRequiredError` when `Expression.getActiveImplementation() === 'legacy'`. It wraps each node in `workflow.expression.withIsolate` (`:123`).

**Fit with Cloudflare Workflows.** The step model maps well conceptually:
- Each `step:ready` maps to a `step.do(stepKeyId, ...)` that returns JSON `StepSlots`.
- A `WaitDeclaration` with `resumeAt` maps to `step.sleepUntil`. One with `acceptsResumeRequest` maps to `step.waitForEvent`.
- Settle-and-plan is a pure function over the stored step rows.

But I would not adopt the package as-is:
1. It assumes Postgres through TypeORM, plus an express server and long-lived workers and sweepers.
2. Its core-only parts (`graph/`, `execution/settlement.ts`, `completion.ts`, `loop-ledger.ts`, `iteration-mapping.ts`) are the reusable pieces. They sit behind the `ExecutionStore`, `StepStore` and `WorkQueue` interfaces, so a Durable Object or D1 store plus a Workflows driver would replace the adapters.
3. It cannot run the Code node or sub-workflows, and it requires the non-legacy expression engine. Workers can't load isolated-vm, so you would need a new engine there (see section 2).

## 2. Expression runtime and engine selection

**How `@n8n/expression-runtime` evaluates.**
- `ExpressionEvaluator` (`src/evaluator/expression-evaluator.ts:184-293`) runs Tournament's `getExpressionCode()` only as a transform and caches the result in an LRU. It then calls `bridge.execute(code, data)`.
- **`IsolatedVmBridge`** (`src/bridge/isolated-vm-bridge.ts`):
  - Loads a runtime IIFE bundle (`readFileSync`, `:99-104`).
  - Wraps the code as `(function(){ <code> }).call(buildContext({getValueAtPath:$0, getArrayElement:$1, callHost:$2}))` and runs it with `context.evalClosureSync(...)` (`:418-460`).
  - Data reaches the isolate through structured-clone callbacks and deep lazy proxies (`runtime/lazy-proxy.ts`, `runtime/context.ts:102-200`).
  - Extensions, luxon and jmespath are separate copies that live inside the isolate (`src/extensions/*`), and `$now` is created in the isolate. So this path is a re-implementation over JSON-cloned data, not the real WorkflowDataProxy.
- **`QuickJsBridge`** (`src/bridge/quickjs-bridge.ts`) uses quickjs-emscripten (WASM) and accepts a `runtimeBundle` string, which avoids the `fs` read (`:502`).

**How `packages/workflow` selects an engine.**
- Config: `@n8n/config/src/configs/expression-engine.config.ts`.
  - `N8N_EXPRESSION_ENGINE` is one of `legacy | vm | quickjs`, default `vm` (`:22-23`).
  - `N8N_EXPRESSION_ENGINE_FRONTEND` defaults to `legacy`.
  - `N8N_EXPRESSION_ENGINE_NATIVE_EVALUATION` defaults to false (`:123`).
- Startup: `cli/src/commands/base-command.ts:261-296` calls `Expression.initExpressionEngine`.
- In `workflow/src/expression.ts`:
  - `initExpressionEngine` (`:319`) returns early for `legacy`. Otherwise `buildEvaluator` (`:381-411`) creates an isolated-vm or QuickJS bridge.
  - `resolveSimpleParameterValue` (`:741-825`) tries native evaluation first if enabled (`:756`). It then runs `initializeGlobalContext(data)` (`:775`), sets `data.extend`/`extendOptional` for legacy only (`:789-792`), attaches the `__sanitize` sanitizer and the extended functions, applies `extendSyntax()` (`:823`), and calls `renderExpression` (`:846`).
  - `renderExpression` uses the vm or QuickJS evaluator if one exists. If an engine is selected but was never initialised, it throws on the backend (`:866-870`). Otherwise it falls to `evaluateLegacy`, which calls `evaluateExpression` (`:917`).
  - `evaluateExpression` lives in `expression-evaluator-proxy.ts:9-23`. It is `new Tournament(errorHandler, undefined, undefined, expressionSandboxHooks)`, and the third argument (`undefined`) selects the default `FunctionEvaluator`.

**Every dynamic-code call site in the requested directories (non-test):**

| File:line | Mechanism | Purpose |
|---|---|---|
| `@n8n/tournament/src/FunctionEvaluator.ts:13` | `new Function('E', code + ';')` | Legacy expression evaluation |
| `workflow/src/workflow-data-proxy.ts:83` | `new Function('return 1')` probe | `isCodeGenerationAllowed()`, which gates `$evaluateExpression` (`:1634`) |
| `workflow/src/safe-regex.ts:76-86, 115-135` | `process.getBuiltinModule('node:vm')` → `vm.createContext`, `new vm.Script`, `runInContext` | Regex with a timeout. Falls back to native regex if `vm` is unavailable (`:181-184`); there is an override seam, `setSafeRegexEngine` (`:186`) |
| `@n8n/expression-runtime/src/bridge/isolated-vm-bridge.ts:28` (`require('isolated-vm')`), `:207-217`, `:274-286` (`compileScript`/`run`/`context.eval`/`evalSync`), `:457` (`evalClosureSync`) | isolated-vm | vm engine |
| `@n8n/expression-runtime/src/bridge/quickjs-bridge.ts:496-497` (`getQuickJS`), `:577` (`vm.evalCode`) | QuickJS WASM | quickjs engine |
| `core/src/nodes-loader/load-class-in-isolation.ts:2,15-16` | `vm.createContext` + `new Script(...).runInContext` | Node class loading. Must be replaced by a static import registry |

There are no `eval(` calls and no other `new Function` in `workflow/src`, `core/src` or `tournament/src`.

**Narrowest seam for `sval`: the Tournament evaluator class.** `Tournament`'s constructor takes `Evaluator: ExpressionEvaluatorClass = FunctionEvaluator` (`tournament/src/index.ts:20-31`, interface in `Evaluator.ts:3-9`). Pass a `SvalEvaluator` there in `workflow/src/expression-evaluator-proxy.ts:9-14`. The class would:
- call `this.instance.getExpressionCode(expr)`, so the same hooks, sanitizer and polyfill run;
- have sval interpret `exports.f = function(E){ <code>; }` once per expression and cache the resulting function;
- call `f.call(data, this.instance.errorHandler)`.

What this keeps:
- The real `WorkflowDataProxy` objects and host proxies.
- The host `extend`/`extendOptional`, set on `data` at `expression.ts:790-791`.
- Host luxon `$now`, and the `__sanitize` property.
- Exactly the legacy semantics: the same code string and the same `E` error handler.

This requires `N8N_EXPRESSION_ENGINE=legacy`. Other changes needed:
1. Patch the `isCodeGenerationAllowed` probe (`workflow-data-proxy.ts:80-90`). Otherwise `$evaluateExpression` is disabled once `new Function` throws in Workers.
2. Call `setSafeRegexEngine(...)`, or confirm workerd's `getBuiltinModule('node:vm')` returns undefined.
3. To use engine v2 as well, either relax `validateExpressionEngine` (`v1-step-executor.ts:129`) or register sval as a named non-legacy engine. `buildEvaluator` and `isVmEngineSelected` in `expression.ts` are private and the engine enum is closed, so that is a small code change.

**Alternatives:**
- Write a `RuntimeBridge` that implements `execute(code, data)` with sval and the runtime bundle. This gets isolate semantics over JSON-cloned data, not the real proxy.
- Use `quickjs` with a Workers-compatible WASM variant and a pre-supplied `runtimeBundle`. This is closest to how n8n already runs expressions in the browser.

`N8N_EXPRESSION_ENGINE_NATIVE_EVALUATION=true` also helps on any path. It runs an in-process, eval-free interpreter for a subset of expressions (`workflow/src/expressions/native-evaluation/index.ts:20-50`), which cuts how often sval is needed.

Two things about sval I could not check because it isn't installed here: whether it uses no `new Function` internally, and whether it offers a step budget or timeout. Confirm both before relying on it.

## 3. How extensions are wired, and the generated code

**Extensions are rewritten by `packages/workflow`, not by Tournament.**
- `extendSyntax()` (`workflow/src/extensions/expression-extension.ts:579-640`) runs `extendTransform()` (`:124`) only when a code chunk matches `EXPRESSION_EXTENSION_REGEX` (`:59-61`), which lists every extension method name plus `$if`.
- The rewrite turns `a.method(args)` into `extend(a, "method", [args])` (`:388-400`) and polyfills optional chaining into `extendOptional`. Results are cached in `EXTENDED_SYNTAX_CACHE`.
- At runtime, `extend()` (`:519-553`) dispatches on type to the `stringExtensions`, `dateExtensions` and other tables.

**Tournament's part** (`tournament/src/ExpressionBuilder.ts:171-290`):
- It runs the before hooks (`ClassExtensionValidator`, `ThisSanitizer`) and then the polyfill. The polyfill rewrites every free identifier to `("x" in ___n8n_data ? ___n8n_data : global).x` (`VariablePolyfill.ts:41-50`).
- It then runs the after hooks (`PrototypeSanitizer`, `DollarSignValidator`); see `workflow/src/expression-sandboxing.ts:572-575`.
- Any member access or call gets a `try { } catch (e) { E(e, this); }` wrapper.

**Example.** For `{{ $json.a.toUpperCase() + $now.toISO() }}`, neither method is an n8n extension, so `extendSyntax` returns it unchanged. The splitter gives `['', code]`, which takes the single-value branch (`:268-287`):

```js
var global = {};
var ___n8n_data = this;
try {
  return ("$json" in ___n8n_data ? ___n8n_data : global).$json.a.toUpperCase() + ("$now" in ___n8n_data ? ___n8n_data : global).$now.toISO();
} catch (e) {
  E(e, this);
}
```

This becomes the body of `new Function('E', code)`, invoked as `.call(data, errorHandler)`. `$now` is the host luxon `DateTime` from `WorkflowDataProxy`.

With an extension, `{{ "abc".isEmpty() }}` first becomes `{{ extend("abc", "isEmpty", []) }}`, which compiles to `return ("extend" in ___n8n_data ? ___n8n_data : global).extend("abc", "isEmpty", []);`.

Mixed text such as `x {{ a }}` instead yields `return ["x ", function (v) { …v = (…); return v || v === 0 || v === false ? v : ""; }.call(this)].join("");` (`:206-266`).

## 4. Code node in 2.44

**It runs only through the task runner.**
- `nodes-base/nodes/Code/Code.node.ts:212-219` always uses `JsTaskRunnerSandbox`.
- That class calls `executeFunctions.startJob('javascript', {code, nodeMode, chunk, ...})` (`JsTaskRunnerSandbox.ts:33, 59, 86, 124`).
- `startJob` lives at `core/src/execution-engine/node-execution-context/base-execute-context.ts:463-486`. It calls `additionalData.startRunnerTask` (interface `workflow/src/interfaces.ts:4035`), which `cli/src/workflow-execute-additional-data.ts:956-990` implements by calling `TaskRequester.startTask`.

**The old in-process sandbox is still in the tree but unused by the Code node.** `JavaScriptSandbox.ts` (vm2 `NodeVM`, `:45-50`) and `Sandbox.ts:getSandboxContext` (`:24-43`) remain. Only the deprecated, hidden `Function` and `FunctionItem` nodes import anything from it, and only `vmResolver`.

Other `JsTaskRunnerSandbox` users are `AiTransform`, `ItemLists` V3 utils, `Transform/Sort` utils and langchain `ToolCode`.

**How the runner executes code** (`@n8n/task-runner/src/js-task-runner/js-task-runner.ts`):
- `buildContext` (`:641-659`) builds a context from `require`, `console`, `$getWorkflowStaticData`, the native globals, the data proxy, the RPC helpers and `items`/`item`.
- Secure mode uses `runInContext(createVmExecutableCode(code))` (`:353, 428, 661-689`).
- Insecure mode uses `new Function('context', 'with(context){ return (async function(){code})(); }')` (`runDirectly`, `:692-700`).

**Minimal path without a task-runner process.** Supply your own `startRunnerTask` in `IWorkflowExecuteAdditionalData`; it is the single choke point, and no node changes are needed. Inside it:
1. Build the context the way `getSandboxContext` does. Use `executeFunctions.getWorkflowDataProxy(itemIndex)` for the real proxy, plus `$getNodeParameter`, `$getWorkflowStaticData`, `helpers`, `items` (all items) or `item` (per item), and a `console` that forwards to `sendMessageToUI`.
2. Interpret `async function(){ <code> }` with sval, injecting the context as sval globals. `with` is unavailable in strict sval, so inject the globals directly.
3. Return `{ok: true, result}`. For `runOnceForEachItem`, honour `settings.chunk.startIndex/count` and rebuild the proxy for each item, as the runner does at `:418-421`.

`JsTaskRunnerSandbox` already validates the results (`result-validation.ts`), so the node itself stays unchanged. Engine v2's additional data would need the same override, since it stubs `startRunnerTask` today (`engine-additional-data.ts:120`).

The runner's prototype hardening (`createVmExecutableCode`) would need an sval equivalent. Also note that `require` of external modules can't work in Workers, so expose only bundled allowlisted modules.