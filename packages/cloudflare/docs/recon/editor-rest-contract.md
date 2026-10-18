# n8n 2.15.0 editor-ui → backend REST contract (for a Cloudflare Worker port)

All paths are relative to `/Users/admin/.t3/scratch/2026-10-16-hey-i-want-your-help-3fc54a9d/n8n/packages/`.

## 0. Transport conventions (apply to every call)

- **HTTP client**: `frontend/@n8n/rest-api-client/src/utils.ts`.
  - `makeRestApiRequest` (L191-207) returns `response.data`. So **every `/rest` response must be `{ "data": <payload> }`**. The backend wraps it in `cli/src/response-helper.ts:15-45` (`res.json({data})`).
  - `getFullApiResponse` (L174-189) returns the raw body and expects `{ count, data }`. It is used by `GET /workflows` and `GET /projects` (paginated).
  - GET/DELETE params go into the query string through `legacyParamSerializer` (L87-99): objects are `JSON.stringify`'d (for example `filter={"projectId":"…"}`) and arrays become `key[]=v`. POST/PATCH/PUT send a JSON body.
  - Headers: `push-ref: <pushRef>` on every call, and `browser-id: <uuid from localStorage 'n8n-browserId'>` whenever the baseURL is relative (L116-118).
  - Errors: the client reads `{ message, code, hint?, meta?, stack? }` plus the HTTP status (L143-160). `mfaRequired: true` throws `MfaRequiredError`.
- **Base URL**: `rootStore.baseUrl = window.BASE_PATH` (`frontend/@n8n/stores/src/useRootStore.ts:51`). It is set by `public/static/base-path.js` (`window.BASE_PATH='/{{BASE_PATH}}/'`).
  - REST root is `baseUrl + restEndpoint`. `restEndpoint` comes from `<meta name="n8n:config:rest-endpoint" content="base64('rest')">` and defaults to `rest` (L52, `metaTagConfig.ts`).
  - Production build: `VUE_APP_PUBLIC_PATH="/{{BASE_PATH}}/"` (`frontend/editor-ui/package.json:9`). The backend rewrites `/{{BASE_PATH}}/`, `%CONFIG_TAGS%` and `{{REST_ENDPOINT}}` in index.html and all dist js/css (`cli/src/commands/start.ts:144-184`).
  - **Worker**: either do the same string replacement at build or serve time (replace with `/`), or build with `VUE_APP_PUBLIC_PATH=/`. index.html also loads `/static/posthog.init.js` and `/static/prefers-color-scheme.css`.
- **Error format** (backend): `{ code, message, hint? }` with the HTTP status (`cli/src/response-helper.ts` `sendErrorResponse`).

---

## 1. Boot sequence (in order)

Entry: `router.beforeEach` (`frontend/editor-ui/src/app/router.ts:994-1055`) runs `initializeCore()` and then `initializeAuthenticatedFeatures()` (`frontend/editor-ui/src/app/init.ts`).

**If anything inside the guard throws, `next()` is never called and the page stays blank (L1041-1054).**

### A. `initializeCore()` (init.ts:44-92)

| # | Call | Shape / notes |
|---|------|---------------|
| 1 | `GET /rest/settings` (`rest-api-client/src/api/settings.ts`) | `{data: FrontendSettings}` (`@n8n/api-types/src/frontend-settings.ts:70-238`). Without a cookie, return `PublicFrontendSettings` with `settingsMode:'public'` (`cli/src/services/frontend.service.ts:558-608`). The store skips the rest of setup for public mode (`settings.store.ts:257-262`). If this fails you get a toast, but later code dereferences `settings.userManagement`, so treat it as required. |
| 2 | `GET /rest/login` (users.ts `loginCurrentUser`; `users.store.ts:166-184`) | `{data: CurrentUserResponse}` when the cookie is valid. Return 401 otherwise; the error is swallowed. Skipped when `previewMode`. |
| 2a | If a user comes back, the login hook (init.ts:234-243) runs: `GET /rest/settings` again (authenticated version) | `RBACStore.setGlobalScopes(user.globalScopes)`. Also fires `void GET /rest/module-settings` and `void loadDynamicBanners()`. |
| 2b | `GET /rest/module-settings` (non-blocking) | `{data: FrontendModuleSettings}` (`frontend-settings.ts:240-303`). `{}` is fine. |
| 2c | `GET /rest/events/session-started` | Only if `settings.telemetry.enabled` (`settings.store.ts:291-293`). |

### B. Setup redirect

If `settings.userManagement.showSetupOnFirstLoad` is true, the router redirects to `/setup` (router.ts:1010-1016). The backend sets it to `!hasInstanceOwner` (frontend.service.ts:~150-158).

### C. `initializeAuthenticatedFeatures()` (init.ts:97-221). Runs only when there is a `currentUser`.

| # | Call | Required? |
|---|------|-----------|
| 1 | `GET /rest/source-control/preferences` | Only if `enterprise.sourceControl`. Failure gives a toast. |
| 2 | `GET /rest/node-translation-headers` | Only if `defaultLocale !== 'en'`. |
| 3 | Cloud plan calls | Only if `deployment.type==='cloud'`. |
| 4 | Data-table size | Only if `activeModules` includes `'data-table'`. |
| 5 | Version check (external host) | Only if `versionNotifications.enabled` with an endpoint (`versions.store.ts:127`). |
| 6 | **`await Promise.all`** (L200-205). **HARD REQUIRED**: a 404 here leaves a blank page. | |
| | `GET /rest/projects/my-projects` | `{data: ProjectListItem[]}` |
| | `GET /rest/projects/personal` | `{data: Project}` with `scopes` |
| | `GET /rest/projects/count` | `{data: {personal:n, team:n, public:n}}` |
| | `GET /rest/roles?withUsageCount=true` | `{data: AllRolesMap}` |
| 7 | `/types/nodes.json` via web worker | Only if `localStorage.N8N_DATA_WORKER==='true'`. |

Type references for row 6:
- `ProjectListItem` / `Project`: `frontend/editor-ui/src/features/collaboration/projects/projects.types.ts`.
  - `ProjectListItem = {id,name,icon,type:'personal'|'team'|'public',description?,createdAt,updatedAt, role, scopes?}`
  - `Project = ProjectSharingData & {relations: ProjectRelation[], scopes: Scope[]}`
- `AllRolesMap = {global:Role[], project:Role[], credential:Role[], workflow:Role[], secretsProviderConnection:Role[]}` (`@n8n/permissions/src/types.ee.ts:90-96`). Role schema: `@n8n/permissions/src/schemas.ee.ts:77-89`.

### D. i18n

English is bundled: `frontend/@n8n/i18n/src/index.ts:6` imports `locales/en.json`. **There is no HTTP call** unless the locale is not `en`.

### E. Canvas route `/workflow/:name` (WorkflowLayout.vue `onMounted`)

Sequence: `pushConnectionStore.pushConnect()`, then `initializeData()`, then `initializeWorkflow()` (`app/composables/useWorkflowInitialization.ts`).

**`initializeData`** (L193-231) uses a `Promise.all` with a toast on error (degrades gracefully):
- `GET /rest/active-workflows` returns `{data: string[]}`.
- `GET {baseUrl}types/credentials.json` returns a **raw JSON array**, not wrapped. The client retries 5 times if the response is not an array (`features/credentials/credentials.api.ts:15-35`).
- `GET /rest/credentials/for-workflow?workflowId=…` (or `?projectId=…` for new workflows) returns `{data: ICredentialsResponse[]}`.
- `GET /rest/variables` only if `enterprise.variables`.
- `GET {baseUrl}types/nodes.json` (raw array) if no node types are loaded yet (`rest-api-client/src/api/nodeTypes.ts:38-40`).
- `void GET /rest/community-node-types` only if `communityNodesEnabled`.

**`initializeWorkflow`** (L345-413):
- New workflow:
  - `/workflow/new` generates a nanoid and redirects to `/workflow/<id>?new=true` (router.ts:368-380).
  - `GET /rest/workflows/<id>/exists` returns `{data:{exists:boolean}}`.
  - `GET /rest/workflows/new?projectId=…` returns `{data:{name, defaultSettings?}}`. Errors are tolerated (useWorkflowState.ts:139-167).
  - `GET /rest/projects/:id` only if `currentProjectId` is set.
- Existing workflow (L290-343):
  - `GET /rest/workflows/:id` returns `{data: IWorkflowDb}`. 404 and 403 route to "not found" / "unauthorized" views.
  - `GET /rest/workflow-history/workflow/:id/version/:versionId` (errors swallowed; `useWorkflowHelpers.ts:1003-1018`).
  - `void GET /rest/workflows/:id/executions/last-successful`.
  - `GET /rest/workflows/:id/collaboration/write-lock` returns `{data: {clientId,userId}|null}`.
- `GET /rest/tags` when the tags dropdown is shown. Can be `[]`.

**Home `/home/workflows`** (`app/views/WorkflowsView.vue:597-611`):
- `GET /rest/workflows?includeScopes=true&includeFolders=…&filter={…}&skip&take&sortBy`. This is a `getFullApiResponse` call: return `{count, data:[…]}`. Folder items carry `resource:'folder'`.
- `GET /rest/active-workflows`.
- `GET /rest/license` returns `{data: UsageState['data']}` (`@n8n/api-types/src/schemas/usage.schema.ts`).
- A second `GET /rest/workflows` with `take=1` for the count.
- `POST /rest/workflow-dependencies/counts` (fire-and-forget).

---

## 2. FrontendSettings (`GET /rest/settings`)

**Type:** `@n8n/api-types/src/frontend-settings.ts:70-238`.

**Reference defaults:** `cli/src/services/frontend.service.ts` `initSettings` (L160-390) and `getSettings` (L404-555). The cleanest approach is to copy the full default object from `initSettings`.

### Fields the UI dereferences without guards (a missing value crashes the UI)

- **Core objects and endpoints**
  - `userManagement {quota, showSetupOnFirstLoad, smtpSetup, authenticationMethod:'email'}` (`settings.store.ts:197-201`; init.ts:75).
  - `authCookie.secure`. If true while served over http on a non-localhost host, the UI calls `document.write` with an insecure-connection warning (settings.store.ts:214-223).
  - `telemetry.enabled` (L291).
  - `enterprise` object with all flags (`isEnterpriseFeatureEnabled[...]`).
  - `sso.{saml,ldap,oidc}` (init.ts:77).
  - `versionCli` (must be a string; init.ts:152 calls `.startsWith`).
  - `banners.dismissed: []`.
  - `versionNotifications {enabled,endpoint,whatsNewEnabled,whatsNewEndpoint,infoUrl}`.
  - `templates {enabled, host}`.
  - `publicApi {enabled, latestVersion, path, swaggerUi:{enabled}}`.
  - `mfa {enabled, enforced}`.
  - `folders {enabled}`.
  - `license {consumerId, environment, planName?}`.
- **Root store** (settings.store.ts:273-289): `urlBaseWebhook`, `urlBaseEditor`, the `endpointForm*`, `endpointWebhook*` and `endpointMcp*` fields, `timezone`, `executionTimeout`, `maxExecutionTimeout`, `instanceId`, `oauthCallbackUrls {oauth1,oauth2}`, `binaryDataMode` (`'default'`).
- **Execution save settings:** `saveDataErrorExecution` / `saveDataSuccessExecution` (`'all'|'none'`), `saveManualExecutions`, `saveExecutionProgress`.
- **Push and modules:** `pushBackend: 'websocket'|'sse'`, `activeModules: string[]`, `allowedModules {}`.
- **Remaining fields, set them anyway:** `previewMode`, `canvasOnly`, `executionMode:'regular'`, `isMultiMain:false`, `defaultLocale:'en'`, `deployment {type:'default'}`, `aiAssistant`, `askAi`, `aiBuilder`, `aiCredits`, `ai {allowSendingParameterValues}`, `posthog {...}`, `dynamicBanners {endpoint, enabled}`, `workflowHistory`, `pruning`, `security`, `evaluation`, `dataTables`, `variables`, `envFeatureFlags: {}`, `hideUsagePage`, `releaseChannel`, `logLevel`, `concurrency`, `nodeJsVersion`, `databaseType`, `isDocker`, `inE2ETests`, `endpointHealth`, `workflowCallerPolicyDefaultOption`, `workflowTagsDisabled`, `personalizationSurveyEnabled`, `communityNodesEnabled`, `unverifiedCommunityNodesEnabled`, `easyAIWorkflowOnboarded`.

### Flags that switch optional features off

| Feature | Setting |
|---|---|
| Enterprise (sharing, LDAP/SAML/OIDC, variables, source control, external secrets, log streaming, worker view, debug-in-editor, named versions, custom roles, …) | All of `enterprise.*` false; `enterprise.projects.team.limit: 0` |
| Telemetry, PostHog, personalization survey, dynamic banners | `telemetry.enabled:false`, `posthog.enabled:false`, `personalizationSurveyEnabled:false`, `dynamicBanners.enabled:false` |
| Version and what's-new checks | `versionNotifications.enabled:false` |
| Templates | `templates.enabled:false` |
| Community nodes | `communityNodesEnabled:false`, `unverifiedCommunityNodesEnabled:false` |
| AI assistant, Ask AI, AI builder, AI credits | `aiAssistant`, `askAi`, `aiBuilder`, `aiCredits` all `{enabled:false, setup:false}` |
| MFA | `mfa:{enabled:false, enforced:false}`. If enforced and `!user.mfaAuthenticated`, the UI forces a redirect to settings (`utils/rbac/checks/shouldEnableMfa.ts`). |
| SSO | `userManagement.authenticationMethod:'email'`; all `sso.*.loginEnabled:false` |
| Insights, data tables, MCP, chat hub, instance-ai | `activeModules: []` (`settings.store.ts:111-113,147-149`; `moduleInitializer.ts:76`) and `/module-settings` returns `{}` |
| Folders | `folders.enabled:false` |
| Tags | `workflowTagsDisabled:true` |
| Hiring banner, non-prod banner | `hiringBannerEnabled:false`, `enterprise.showNonProdBanner:false` |
| Cloud | `deployment.type !== 'cloud'` |
| Usage page | `hideUsagePage:true` |

---

## 3. Auth

**Cookie:** `n8n-auth` (`cli/src/constants.ts:63`). It holds an httpOnly JWT with payload `{id, hash, browserId: sha(browserId), usedMfa}` (`cli/src/auth/auth.service.ts:207-233`).

**Browser ID:**
- The backend checks the `browser-id` header against the JWT (L276-294).
- The check is skipped on GET for `/rest/push`, `/rest/binary-data/`, the OAuth callbacks, and `/types/nodes.json|credentials.json|node-versions.json` (L71-96).
- A Worker may ignore browser-id entirely.

**`POST /rest/owner/setup`** (skipAuth; `cli/src/controllers/owner.controller.ts:25-30`)
- Body: `OwnerSetupRequestDto {email, firstName, lastName, password}` (`@n8n/api-types/src/dto/owner/owner-setup-request.dto.ts`).
- Response: sets the cookie and returns `{data: PublicUser}`. The UI then calls `setCurrentUser`, which runs the login hook (settings refetch).

**`POST /rest/login`** (`cli/src/controllers/auth.controller.ts:53-107`)
- Body: `LoginRequestDto {emailOrLdapLoginId, password, mfaCode?, mfaRecoveryCode?}`.
- Response: sets the cookie and returns `{data: PublicUser}`.

**`GET /rest/login`** (L184-196) returns the current user, or 401.

**`POST /rest/logout`** (L272-276) returns `{data:{loggedOut:true}}` and clears the cookie. The client removes `n8n-browserId` from localStorage.

**`/rest/me` endpoints:** `PATCH /rest/me`, `PATCH /rest/me/settings`, `PATCH /rest/me/password`, `POST /rest/me/survey` (`rest-api-client/src/api/users.ts`).

**User object**, built by `UserService.toPublic` (`cli/src/services/user.service.ts:103-135`):
- Base fields: `userDetailSchema` (`@n8n/api-types/src/schemas/user.schema.ts:26-44`).
- Extra fields: `CurrentUserResponse`/`IUser` (`rest-api-client/src/api/users.ts`).

```
{ id, email, firstName, lastName,
  role: 'global:owner'|'global:admin'|'global:member'|'global:chatUser',  // string slug
  isOwner: boolean, isPending: false, signInType: 'email',
  mfaEnabled: false, mfaAuthenticated: false,
  settings: IUserSettings|null, personalizationAnswers: {}|null,
  globalScopes: Scope[],          // REQUIRED for RBAC (init.ts:237)
  featureFlags?: {} , createdAt, lastActiveAt? }
```

Scope lists:
- `globalScopes`: use `GLOBAL_OWNER_SCOPES` (`@n8n/permissions/src/roles/scopes/global-scopes.ee.ts:3`).
- Project scopes: `PERSONAL_PROJECT_OWNER_SCOPES` (`project-scopes.ee.ts:55`).
- Workflow scopes: `WORKFLOW_SHARING_OWNER_SCOPES` (`workflow-sharing-scopes.ee.ts:3`).
- Credential scopes: `CREDENTIALS_SHARING_OWNER_SCOPES`.
- `@n8n/permissions` is plain TypeScript and can be imported into the Worker.

**Scopes decide whether the canvas is editable.** `NodeView.vue:292-307`: the canvas is read-only unless `getResourcePermissions(workflow.scopes).workflow.update` holds, with a fallback to project scopes. Execution needs `workflow:execute`. So `GET /workflows/:id`, list items, `/projects/personal` and `/projects/my-projects` must all return `scopes`.

---

## 4. Workflows

Frontend calls are in `frontend/editor-ui/src/app/api/workflows.ts`, `app/stores/workflows.store.ts` and `app/stores/workflowsList.store.ts`. The backend controller is `cli/src/workflows/workflows.controller.ts`.

| Method & path | Request | Response (`data`) |
|---|---|---|
| `GET /workflows` | `includeScopes, includeFolders, onlySharedWithMe, filter={projectId,query,tags,active,isArchived,parentFolderId}, skip, take, sortBy, select` | **Raw** `{count, data: WorkflowListResource[]}` (controller L124-146 uses `res.json`). `WorkflowResource`: `frontend/editor-ui/src/Interface.ts:278-294` |
| `GET /workflows/new` | `?name&projectId&parentFolderId` | `{name}` (FE also reads `defaultSettings`) |
| `GET /workflows/:id` | none | `IWorkflowDb` + `scopes` + `checksum` (`Interface.ts:240-266`) |
| `GET /workflows/:id/exists` | none | `{exists}` |
| `POST /workflows` | `CreateWorkflowDto` (`@n8n/api-types/src/dto/workflows/create-workflow.dto.ts`, base `base-workflow.dto.ts`): `{id?, name, nodes, connections, settings, pinData, meta, tags: string[], parentFolderId?, projectId, active:false}`. The id is client-generated (16-char nanoid) | `IWorkflowDb + scopes + checksum` (store L1317-1351) |
| `PATCH /workflows/:id[?forceSave=true]` | `UpdateWorkflowDto` (partial base, plus `expectedChecksum`, `autosaved`) | Must include **`checksum`** or the UI throws "Failed to update workflow" (store L1353-1371). Also `versionId`. |
| `DELETE /workflows/:id` | none | `true` |
| `POST /workflows/:id/archive` | `{expectedChecksum?}` | workflow + checksum |
| `POST /workflows/:id/unarchive` | none | workflow + checksum |
| `POST /workflows/:id/activate` | `ActivateWorkflowDto {versionId, name?, description?, expectedChecksum?}` | workflow + `activeVersionId` + checksum |
| `POST /workflows/:id/deactivate` | `{expectedChecksum?}` | workflow + checksum |
| `GET /active-workflows` | none | `string[]` |
| `GET /workflows/:id/executions/last-successful` | none | `IExecutionResponse | null` |
| `GET /workflows/:id/collaboration/write-lock` | none | `null` (the canvas becomes read-only only if a lock exists for another `clientId`; `collaboration.store.ts:63-82`) |

**Checksum:** `calculateWorkflowChecksum` in `workflow/src/workflow-checksum.ts:22-89`. It is SHA-256 over the sorted-key JSON of `name, description, nodes, connections, settings, meta, pinData, isArchived, activeVersionId`. Uses WebCrypto, so it is Worker-safe; import it from `n8n-workflow`.

**Required `IWorkflowDb` fields:** `id, name, active, isArchived, createdAt, updatedAt, nodes, connections, settings, versionId, activeVersionId, homeProject, scopes, tags, pinData, meta, checksum`.

### Manual run

The flow is in `app/composables/useRunWorkflow.ts`.

1. Before running, the editor saves the workflow if it is dirty or unsaved (L176-178). The backend always runs the **stored** workflow (controller L513-552).
2. It refuses to run if the push connection is not open (L119-123).
3. It sets `activeExecutionId = null` (L126).
4. **`POST /rest/workflows/:id/run`**, with header `push-ref`. Body is `IStartRunData` (`Interface.ts:187-204`; built at useRunWorkflow.ts:340-375):

```
{ workflowId, startNodes?: [{name, sourceData: ISourceData|null}],
  destinationNode?: {nodeName, mode:'inclusive'|'exclusive'},   // n8n-workflow IDestinationNode
  runData?: IRunData (only partial exec), dirtyNodeNames?: string[],
  triggerToStartFrom?: {name, data?: ITaskData}, chatSessionId?, agentRequest? }
```

Backend payload variants: `cli/src/workflows/workflow.request.ts:34-62`.

5. Response is `{data:{executionId:string}}` or `{data:{waitingForWebhook:true}}` (`IExecutionPushResponse`, `features/execution/executions/executions.types.ts:68-71`).

**Stop:** `POST /rest/executions/:id/stop` returns `IExecutionsStopData {mode,startedAt,stoppedAt,finished?,status}`. The UI then polls `GET /executions/:id` until the status is not running or waiting (useRunWorkflow.ts:512-572).

**Test webhook:** `DELETE /rest/test-webhook/:workflowId`.

### Push connection

Store: `app/stores/pushConnection.store.ts`.

- **URL** (L47-60): `ws(s)://<host><restUrl>/push?pushRef=<pushRef>` when `pushBackend==='websocket'`. With `'sse'` it is `<restUrl>/push?pushRef=…` over `EventSource(withCredentials)`.
- `pushRef` is a 10-char lowercase random string kept in sessionStorage `n8n-client-id` (useRootStore.ts:39-48). The same value goes in the `push-ref` header.
- **Auth:** cookie only. The backend validates the Origin header against Host/X-Forwarded-Host (`cli/src/push/index.ts:103-155`, `origin-validator.ts`).
- **Messages from the server:**
  - Format is JSON `{type, data}` (`cli/src/push/abstract.push.ts:80-94`).
  - `nodeExecuteAfterData` is sent as a **binary frame**. The client decodes any ArrayBuffer as UTF-8 (store L65-81).
  - SSE format is `data: <json>\n\n`, with keepalive `:ping\n\n` (`cli/src/push/sse.push.ts`).
- **Messages from the client** (WS only; SSE `sendMessage` is a no-op):
  - `{"type":"heartbeat"}` every 30 s (`useWebSocketClient.ts:33-38`).
  - Collaboration: `{type:'workflowOpened'|'workflowClosed', workflowId}`, `writeAccessRequested`, `writeAccessHeartbeat`, `writeAccessReleaseRequested` (`features/collaboration/collaboration/collaboration.store.ts`). These can be ignored.

**Message types.** Definitions are in `@n8n/api-types/src/push/*.ts`; the union is in `index.ts`. Dispatch is in `app/composables/usePushConnection/usePushConnection.ts:61-99`, with handlers in `app/composables/usePushConnection/handlers/`.

- `executionStarted {executionId, mode, startedAt, workflowId, workflowName?, retryOf?, flattedRunData: string}`. `flattedRunData` is `flatted.stringify(IRunData)`, and `"[{}]"` is fine. Handler: `executionStarted.ts`. It is ignored if `activeExecutionId === undefined`.
- `executionWaiting {executionId}`.
- `executionFinished {executionId, workflowId, status}`. Handler: `executionFinished.ts:64-161`. It **then calls `GET /rest/executions/:id`** for final data. If that returns nothing, the UI keeps the pushed run data and clears the active execution.
- `executionRecovered {executionId}` (also fetches the execution).
- `nodeExecuteBefore {executionId, nodeName, data: ITaskStartedData{startTime, executionIndex, source:[]}}`.
- `nodeExecuteAfter {executionId, nodeName, data: ITaskData without .data, itemCountByConnectionType: {main:[n,…]}}`. The UI inserts placeholder items.
- `nodeExecuteAfterData {executionId, nodeName, data: ITaskData (full), itemCountByConnectionType}`. It replaces the matching `executionIndex` (`workflows.store.ts:1255-1264`), so it **must follow** `nodeExecuteAfter` for the same `executionIndex`. `ITaskData` is defined at `workflow/src/interfaces.ts:2799-2822`.
- Workflow events: `workflowActivated {workflowId, activeVersionId}`, `workflowDeactivated`, `workflowAutoDeactivated`, `workflowFailedToActivate {workflowId, errorMessage}`.
- Webhook events: `testWebhookReceived {executionId, workflowId}`, `testWebhookDeleted {executionId?, workflowId}`.
- Hot reload: `reloadNodeType`, `removeNodeType` (`{name, version}`), `nodeDescriptionUpdated {}`.
- Other: `sendConsoleMessage {source, messages}`, `sendWorkerStatusMessage`, `updateBuilderCredits`. Collaboration messages (`collaboratorsChanged`, `writeAccessAcquired`, `writeAccessReleased`) are handled in the collaboration store.

The server emission order is in `cli/src/execution-lifecycle/execution-lifecycle-hooks.ts:218-402`: executionStarted, then for each node nodeExecuteBefore → nodeExecuteAfter → nodeExecuteAfterData, then executionFinished or executionWaiting.

---

## 5. Executions

Frontend: `features/execution/executions/executions.store.ts:157-330`. Backend: `cli/src/executions/executions.controller.ts`.

- **`GET /executions?filter={…}&limit&firstId&lastId`** returns `{data:{count, estimated, results: ExecutionSummaryWithScopes[], concurrentExecutionsCount}}` (`executions.types.ts:83-88`).
  - `ExecutionSummary` is defined at `workflow/src/interfaces.ts:3320+`.
  - Filter keys (`cli/src/executions/execution.service.ts:61+`): `id, finished, mode, retryOf, retrySuccessId, status[], waitTill, workflowId, metadata[], startedAfter, startedBefore, annotationTags, vote, projectId`.
  - Default limit is 20, max 100 (`parse-range-query.middleware.ts`).
- **`GET /executions/:id`** returns `{data: IExecutionFlattedResponse}`. The shape is `{id, finished, mode, status, startedAt, stoppedAt, createdAt, workflowId, workflowData: IWorkflowDb, data: string}`, where **`data` is a `flatted.stringify(IRunExecutionData)` string** (`execution.service.ts:164-167`). The client runs `flatted.parse` (`executions.utils.ts:405-420`). `null` or undefined means "not stored".
  - `IRunExecutionData` v1 shape: `{version:1, startData:{}, resultData:{runData, pinData?, lastNodeExecuted?, error?}, executionData?, waitTill?}` (`workflow/src/run-execution-data-factory.ts:86-101`).
  - The DB stores the same flatted string (`@n8n/db/src/repositories/execution.repository.ts:424`).
  - The backend rejects non-numeric ids; the UI does not care.
- `POST /executions/:id/stop` returns `IExecutionsStopData`.
- `POST /executions/stopMany {filter}` returns `{stopped}`.
- `POST /executions/:id/retry {loadWorkflow?}` returns `IExecutionResponse`.
- `POST /executions/delete {ids?:string[], deleteBefore?, filters?}`.
- `PATCH /executions/:id {tags?, vote?}` (annotations).
- `GET /executions/versions/:workflowId`.

---

## 6. Credentials and type definitions

Frontend: `features/credentials/credentials.api.ts`. Types: `credentials.types.ts:7-38`.

- `GET /credentials?includeScopes&includeData=true&filter&onlySharedWithMe&includeGlobal` returns `ICredentialsResponse[]`. Each item is `{id,name,type,createdAt,updatedAt,isManaged,homeProject?,sharedWithProjects?,scopes?,data?}`.
- `GET /credentials/for-workflow?workflowId|projectId` returns `ICredentialsResponse[]`.
- `GET /credentials/new?name` returns `{name}`.
- `GET /credentials/:id?includeData=true` returns the decrypted credential. Secret fields are blanked with `CREDENTIAL_BLANKING_VALUE` (`workflow/src/constants.ts:18`).
- `POST /credentials`: `CreateCredentialDto {name,type,data,projectId?,uiContext?,isGlobal?,isResolvable?}` (`@n8n/api-types/src/dto/credentials/create-credential.dto.ts`).
- `PATCH /credentials/:id` with `ICredentialsDecrypted`.
- `DELETE /credentials/:id` returns `true`.
- `POST /credentials/test {credentials}` returns `{status:'OK'|'Error', message}` (`workflow/src/interfaces.ts:2123-2130`).
- OAuth: `GET /oauth1-credential/auth`, `GET /oauth2-credential/auth`, plus the callbacks.

**Type files:**
- `GET {BASE_PATH}types/nodes.json` and `types/credentials.json` are **unwrapped JSON arrays**, outside `/rest`. `types/node-versions.json` is a `string[]` of `name@version`.
- The backend serves them from `staticCacheDir` with auth middleware (`cli/src/server.ts:298-317`).
- They are generated by `FrontendService.generateTypes` (`frontend.service.ts:390-402`) from `LoadNodesAndCredentials.collectTypes()`, merged across packages, with `iconUrl: "icons/<package>/<path>"`.
- Each node package produces `dist/types/nodes.json` and `dist/types/credentials.json` at build time via `n8n-generate-metadata` (`core/bin/generate-metadata`; nodes-base `package.json:11`). The packages are not currently built (`nodes-base/dist` is absent).
- Icons are fetched from `/icons/{@scope/}pkg/*.svg|png` (server.ts:323-340). Note that `iconUrl` is relative, without a leading slash.
- `POST /rest/node-types` is only called for nodes that lack `properties` (`useNodeHelpers.ts:885-908`), so a full nodes.json avoids it.
- Load-options calls (`POST /dynamic-node-parameters/options|resource-locator-results|resource-mapper-fields|action-result`) are needed only for dynamic dropdowns.

---

## 7. Other endpoints: crash vs graceful

**Hard-fail (blank page or broken view):**
- `/rest/settings`
- The four calls in init.ts:200-205: `/projects/my-projects`, `/projects/personal`, `/projects/count`, `/roles`.
- `GET /rest/login` (401 is OK; other errors are swallowed).
- `GET /workflows/:id`
- `GET /workflows` returning raw `{count, data}`
- `/types/*.json` (the client retries five times, then throws)

**Toast but the canvas loads** (useWorkflowInitialization.ts:215-230): `/active-workflows`, `/credentials/for-workflow`, `/variables`.

**Silently tolerated:**
- `/module-settings`, `/community-node-types`, `workflow-history` version fetch, `last-successful`, `/workflow-dependencies/counts`
- `/workflows/new` (falls back to a default name)
- Dynamic banners, version checks, and posthog (all external, gated by flags)

**Gated by settings, so they are never called with the flags in §2:**
- source-control (`/source-control/preferences`)
- variables
- external secrets
- LDAP, SAML, OIDC
- MFA (`/mfa/*`)
- insights (`/insights/*`, module)
- data tables
- chat-hub, instance-ai, MCP
- community packages (`/community-packages`)
- cloud plan
- AI assistant and builder (`/ai/*`)
- templates (external host)
- workers (`/orchestration`)
- log streaming (`/eventbus`)

**Stub with empty data (cheap):**

| Endpoint | Stub response |
|---|---|
| `GET /tags` | `[]` |
| `GET /annotation-tags` | `[]` |
| `GET /users` | `{count, items}` |
| `GET /license` | `{usage:{activeWorkflowTriggers:{limit:-1,value:0,warningThreshold:0.8},workflowsHavingEvaluations:{limit:-1,value:0}}, license:{planId:'',planName:'Community'}}` |
| `GET /projects/:id` | `Project` with relations and scopes |
| `GET /projects/:projectId/folders/...` | Only if `folders.enabled` |
| `GET /options/timezones` | Timezone list |
| `POST /owner/dismiss-banner` | Any success |
| `GET /workflow-history/...` | Any; errors are swallowed |

---

## Things to watch when building the Worker

1. **PATCH needs `checksum`.** `PATCH /workflows/:id` (and deactivate) must return `checksum`, or every save fails with "Failed to update workflow".
2. **Scopes control editability.** Without `scopes` on the workflow and the personal project, the canvas opens read-only and Execute is disabled.
3. **No manual runs without push.** The editor refuses to run until the push socket is connected. Each node's `nodeExecuteAfterData` must follow its `nodeExecuteAfter` with the same `executionIndex`.
4. **Two pagination endpoints skip the wrapper.** `GET /workflows` and `GET /projects` return `{count, data}`; every other `/rest` response is `{data: …}`.