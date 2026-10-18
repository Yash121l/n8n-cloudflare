# Integration to-do (cross-agent patches)

Apply after the owning agent finishes, then run the full suites.

- [x] (from C) `src/api/routes/node-types.ts`: delete the old `dynamicRoutes` block, its `nodeTypeRoutes.route('/dynamic-node-parameters', dynamicRoutes)` mount and imports only it uses. `src/api/routes/dynamic-parameters.ts` replaces them.
- [x] (from C) Production, trigger, webhook and sub-workflow runs: call `checkWorkflowCredentials(env.DB, { workflowId }, workflow.nodes)` from `src/runtime/credential-access.ts` before running and fail the execution with its message (agent B's paths).
- [ ] (from C) `stopExecution` in `src/runtime/service.ts` is ready for a cancel registry (agent B's finding 13 patch).
- [x] (from B) `src/api/routes/settings.ts`: read save/timeout/pruning values from `executionsConfig(c.env)` (`src/execution/config.ts`) instead of hard-coded `saveDataErrorExecution`, `saveDataSuccessExecution`, `saveManualExecutions`, `saveExecutionProgress`, `executionTimeout`, `maxExecutionTimeout`, `pruning`.
- [x] (from B) `wrangler.jsonc`: add `"triggers": { "crons": ["*/15 * * * *"] }` so the pruning `scheduled` handler runs.
- [ ] (from B) Flake to investigate: "Node type n8n-nodes-base.webhook was not preloaded" on first activation in a fresh isolate (`src/runtime/node-types.ts`, now owned by the AI agent).
- [ ] (decision) Sub-workflow draft vs published follows the root mode (stock follows the immediate caller). Pruning soft-deletes then hard-deletes after 1 hour (stock hard-deletes non-manual at once).
- [ ] (from D) `build.mjs`: empty the output folder before bundling (`rmSync(out, { recursive: true, force: true })` when `out` is a directory); stale chunks inflate the upload to 23 MB gzip. Owned by the AI agent right now.
- [ ] (from D) `GET /rest/workflows/:id` does not return `staticData` (agent A area); check stock behavior.
- [ ] (cost) Dynamic Workers: 1,000 Code tasks/month included, then $0.002 each. Consider reusing isolates per workflow version if cost matters.
