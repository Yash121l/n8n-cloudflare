import type { FrontendSettings } from '@n8n/api-types';
import { Hono } from 'hono';

import { isSecureRequest } from '../../auth/middleware';
import { sha256Hex } from '../../auth/jwt';
import { getSetting } from '../../db/settings';
import { hasClaimedOwner } from '../../db/users';
import type { Env } from '../../env';
import { N8N_VERSION } from '../../version';
import type { AppContext, AppEnv } from '../app';
import { baseUrlOf, ok } from '../app';
import { executionsConfig } from '../../execution/config';

export const settingsRoutes = new Hono<AppEnv>();

const DEFAULT_TIMEZONE = 'America/New_York';

/** Mirrors `PublicFrontendSettings` in cli/src/services/frontend.service.ts. */
interface PublicFrontendSettings {
	settingsMode: 'public';
	defaultLocale: FrontendSettings['defaultLocale'];
	userManagement: Pick<
		FrontendSettings['userManagement'],
		'authenticationMethod' | 'showSetupOnFirstLoad' | 'smtpSetup' | 'passwordMinLength'
	>;
	sso: {
		saml: Pick<FrontendSettings['sso']['saml'], 'loginEnabled'>;
		ldap: FrontendSettings['sso']['ldap'];
		oidc: Pick<FrontendSettings['sso']['oidc'], 'loginEnabled' | 'loginUrl'>;
	};
	authCookie: FrontendSettings['authCookie'];
	previewMode: FrontendSettings['previewMode'];
	enterprise: Pick<FrontendSettings['enterprise'], 'saml' | 'oidc' | 'ldap'>;
	communityNodesEnabled: FrontendSettings['communityNodesEnabled'];
}

async function instanceId(env: Env): Promise<string> {
	const key = env.N8N_ENCRYPTION_KEY;
	return await sha256Hex(key.slice(Math.round(key.length / 2)));
}

async function buildSettings(c: AppContext): Promise<FrontendSettings> {
	const baseUrl = baseUrlOf(c);
	const executions = executionsConfig(c.env);
	const hasOwner = await hasClaimedOwner(c.env.DB);
	const dismissedBanners = await getSetting<string[]>(c.env.DB, 'ui.banners.dismissed', []);
	const easyAIWorkflowOnboarded = await getSetting<boolean>(
		c.env.DB,
		'easyAIWorkflowOnboarded',
		false,
	);

	return {
		settingsMode: 'authenticated',
		inE2ETests: false,
		isDocker: false,
		databaseType: 'sqlite',
		previewMode: false,
		endpointForm: 'form',
		endpointFormTest: 'form-test',
		endpointFormWaiting: 'form-waiting',
		endpointMcp: 'mcp',
		endpointMcpTest: 'mcp-test',
		endpointWebhook: 'webhook',
		endpointWebhookTest: 'webhook-test',
		endpointWebhookWaiting: 'webhook-waiting',
		// The editor appends this to the page origin, so it needs the leading slash.
		endpointHealth: '/healthz',
		healthCheckTimeoutMs: 5000,
		saveDataErrorExecution: executions.saveDataOnError,
		saveDataSuccessExecution: executions.saveDataOnSuccess,
		saveManualExecutions: executions.saveDataManualExecutions,
		saveExecutionProgress: executions.saveExecutionProgress,
		executionTimeout: executions.timeout,
		maxExecutionTimeout: executions.maxTimeout,
		workflowCallerPolicyDefaultOption: 'workflowsFromSameOwner',
		excludeNodes: [],
		timezone: c.env.N8N_DEFAULT_TIMEZONE ?? DEFAULT_TIMEZONE,
		urlBaseWebhook: `${baseUrl}/`,
		urlBaseEditor: baseUrl,
		urlBaseWebhookTest: `${baseUrl}/`,
		binaryDataMode: 'default',
		nodeJsVersion: '22.0.0',
		nodeEnv: 'production',
		versionCli: N8N_VERSION,
		concurrency: -1,
		evaluationConcurrencyLimit: 1,
		authCookie: { secure: isSecureRequest(c) },
		releaseChannel: 'stable',
		oauthCallbackUrls: {
			oauth1: `${baseUrl}/rest/oauth1-credential/callback`,
			oauth2: `${baseUrl}/rest/oauth2-credential/callback`,
		},
		jwksUri: `${baseUrl}/rest/.well-known/jwks.json`,
		versionNotifications: {
			enabled: false,
			endpoint: '',
			whatsNewEnabled: false,
			whatsNewEndpoint: '',
			infoUrl: 'https://docs.n8n.io/hosting/installation/updating/',
		},
		dynamicBanners: {
			endpoint: '',
			enabled: false,
			filters: { publishedWorkflowCount: 0 },
		},
		instanceId: await instanceId(c.env),
		telemetry: { enabled: false },
		posthog: {
			enabled: false,
			apiHost: '',
			apiKey: '',
			autocapture: false,
			disableSessionRecording: true,
			proxy: '',
			debug: false,
		},
		personalizationSurveyEnabled: false,
		defaultLocale: 'en',
		userManagement: {
			quota: -1,
			showSetupOnFirstLoad: !hasOwner,
			smtpSetup: false,
			authenticationMethod: 'email',
			passwordMinLength: 8,
		},
		sso: {
			managedByEnv: false,
			saml: { loginEnabled: false, loginLabel: '' },
			ldap: { loginEnabled: false, loginLabel: '' },
			oidc: {
				loginEnabled: false,
				loginUrl: `${baseUrl}/rest/sso/oidc/login`,
				callbackUrl: `${baseUrl}/rest/sso/oidc/callback`,
			},
		},
		logStreaming: { managedByEnv: false },
		dataTables: { maxSize: 50 * 1024 * 1024 },
		publicApi: { enabled: false, latestVersion: 1, path: 'api', swaggerUi: { enabled: false } },
		workflowTagsDisabled: false,
		workflowsAutosaveDisabled: false,
		workflowsGroupsWithTriggersEnabled: false,
		workflowsGroupsWithManyBoundariesEnabled: false,
		useWorkflowPublicationService: false,
		granularCredentialSharing: false,
		logLevel: 'info',
		hiringBannerEnabled: false,
		aiAssistant: { enabled: false, setup: false, cloudUbbEnabled: false },
		templates: { enabled: false, host: '' },
		executionMode: 'regular',
		isMultiMain: false,
		pushBackend: 'websocket',
		communityNodesEnabled: false,
		unverifiedCommunityNodesEnabled: false,
		communityNodesManagedByEnv: false,
		deployment: { type: 'default' },
		allowedModules: {},
		enterprise: {
			sharing: false,
			ldap: false,
			saml: false,
			oidc: false,
			mfaEnforcement: false,
			logStreaming: false,
			advancedExecutionFilters: false,
			variables: true,
			sourceControl: false,
			auditLogs: false,
			externalSecrets: false,
			showNonProdBanner: false,
			debugInEditor: false,
			binaryDataS3: false,
			workerView: false,
			// Admins can be invited and roles changed. Stock gates this behind a license.
			advancedPermissions: true,
			workflowDiffs: false,
			namedVersions: false,
			provisioning: false,
			projects: { team: { limit: 0 } },
			customRoles: false,
			personalSpacePolicy: false,
			dataRedaction: false,
			otelCustomSpanAttributes: false,
			workflowReviews: false,
		},
		mfa: { enabled: false, enforced: false },
		hideUsagePage: true,
		license: { consumerId: 'unknown', environment: 'production', planName: 'Community' },
		variables: { limit: -1 },
		banners: { dismissed: dismissedBanners },
		askAi: { enabled: false },
		aiBuilder: { enabled: false, setup: false },
		aiCredits: { enabled: false, credits: 0, setup: false },
		ai: { allowSendingParameterValues: true },
		workflowHistory: { pruneTime: 24, licensePruneTime: 24 },
		pruning: {
			isEnabled: executions.pruneData,
			maxAge: executions.pruneDataMaxAge,
			maxCount: executions.pruneDataMaxCount,
		},
		security: { blockFileAccessToN8nFiles: true, postMessageAllowedOrigins: [] },
		chatTrigger: { disablePublicChat: false },
		easyAIWorkflowOnboarded,
		folders: { enabled: true },
		workerPools: { enabled: false },
		evaluation: {
			quota: 0,
			collectionsEnabled: false,
			configEvalsEnabled: false,
			agentEvalsEnabled: false,
			forceAgentWorthTesting: false,
		},
		inbox: { enabled: false, availableTypes: [], failedTypes: [] },
		activeModules: [],
		canvasOnly: false,
		collaboration: { crdt: 'off' },
		envFeatureFlags: {},
		expressionEngine: 'legacy',
	};
}

function toPublicSettings(settings: FrontendSettings): PublicFrontendSettings {
	return {
		settingsMode: 'public',
		defaultLocale: settings.defaultLocale,
		userManagement: {
			authenticationMethod: settings.userManagement.authenticationMethod,
			showSetupOnFirstLoad: settings.userManagement.showSetupOnFirstLoad,
			smtpSetup: settings.userManagement.smtpSetup,
			passwordMinLength: settings.userManagement.passwordMinLength,
		},
		sso: {
			saml: { loginEnabled: settings.sso.saml.loginEnabled },
			ldap: settings.sso.ldap,
			oidc: { loginEnabled: settings.sso.oidc.loginEnabled, loginUrl: settings.sso.oidc.loginUrl },
		},
		authCookie: settings.authCookie,
		previewMode: settings.previewMode,
		enterprise: {
			saml: settings.enterprise.saml,
			oidc: settings.enterprise.oidc,
			ldap: settings.enterprise.ldap,
		},
		communityNodesEnabled: settings.communityNodesEnabled,
	};
}

settingsRoutes.get('/settings', async (c) => {
	const settings = await buildSettings(c);
	return ok(c, c.get('user') ? settings : toPublicSettings(settings));
});

/** No backend modules are active, so there are no module settings to report. */
settingsRoutes.get('/module-settings', (c) => ok(c, {}));
