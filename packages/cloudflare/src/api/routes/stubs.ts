/**
 * Stubs for editor endpoints that the engine does not back. Mounted last, so real routes win.
 *
 * | Path | Answer | Why |
 * |---|---|---|
 * | GET /favorites, POST /favorites, DELETE /favorites/:type/:id | Real, kept per user in `settings` | Home page calls GET on boot |
 * | GET /options/timezones | `{ name: label }` map from @vvo/tzdb | Workflow settings page |
 * | GET /license | Usage with real trigger count, plan Community | Usage page |
 * | POST /license/* | 400 | No licence management |
 * | PATCH /user-settings/nps-survey | Writes `user.settings.npsSurvey` | Same as stock |
 * | POST /webhooks/find | Row of `webhook_entity` or null | Activation conflict check |
 * | GET /events/session-started, /credential-translation, /node-translation-headers | null | No telemetry, English only |
 * | GET /workflows/:id/(test-runs, evaluation-configs, eval-versions) | [] | Evaluations are off |
 * | GET /community-packages, /community-node-types | [] (writes 400) | No runtime installs |
 * | GET /api-keys, /api-keys/scopes | [] (writes 400) | Public API is off |
 * | /mfa/* | 400 | No TOTP secrets or recovery codes |
 * | /ldap, /sso/*, /source-control, /external-secrets, /secret-providers, /eventbus, /settings/security, /credential-resolvers, /workflow-review-requests, /role-mapping-rule, /projects/:id/pool-settings | 403 `Plan lacks license for this feature` | Licensed features |
 * | GET /instance-version-history/* | null values | Publish timeline |
 * | GET /third-party-licenses | 404 text | File is not shipped |
 *
 * Module routes (insights, data tables, chat hub, instance AI, agents, MCP, quick connect, promotions)
 * are not registered. Stock answers 404 for them when the module is off, and `activeModules` is empty.
 */
import { Hono } from 'hono';

import type { AppEnv } from '../app';
import { coreStubs } from './stubs/core';
import { disabledStubs } from './stubs/disabled';
import { favoriteRoutes } from './stubs/favorites';

export const stubRoutes = new Hono<AppEnv>();

stubRoutes.route('/', favoriteRoutes);
stubRoutes.route('/', coreStubs);
stubRoutes.route('/', disabledStubs);
