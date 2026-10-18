/**
 * OAuth1 and OAuth2 credential connect flow. Port of OauthService
 * (packages/cli/src/oauth/oauth.service.ts) for static credentials. Flows that need discovery
 * (`serverUrl`), dynamic client registration or dynamic credentials are not supported.
 */
import { AuthError, ClientOAuth2, resolveClientAuthOptions } from '@n8n/client-oauth2';
import type { ClientOAuth2Options } from '@n8n/client-oauth2';
import type { ICredentialDataDecryptedObject, IDataObject } from 'n8n-workflow';
import { UserError, jsonParse } from 'n8n-workflow';
import { createHmac, randomBytes } from 'node:crypto';

import { buildAdditionalData } from '../execution/runner';
import { getSetting, setSetting } from '../db/settings';
import type { CredentialRow } from '../db/types';
import type { Env } from '../env';
import { bootstrap } from './bootstrap';
import { CredentialsHelper } from './credentials-helper';
import { loadCredentialType } from './node-types';
import type { RunContext } from './service';

export const MAX_CSRF_AGE_MS = 5 * 60 * 1000;
const FLOW_KEY_PREFIX = 'oauth:flow:';

/** Types whose scope the user edits, so a stored scope must survive a reconnect. */
const EDITABLE_SCOPE_TYPES = [
	'oAuth2Api',
	'googleOAuth2Api',
	'microsoftOAuth2Api',
	'atlassianOAuth2Api',
	'highLevelOAuth2Api',
	'mcpOAuth2Api',
	'snowflakeOAuth2Api',
	'facebookGraphApiOAuth2Api',
	'facebookGraphAppOAuth2Api',
	'stravaOAuth2Api',
	'wordpressOAuth2Api',
	'figmaOAuth2Api',
	'gumroadOAuth2Api',
	'googleCloudStorageOAuth2Api',
];

export class OauthFlowError extends UserError {
	constructor(
		message: string,
		readonly status: 400 | 401 | 404,
		readonly reason?: string,
	) {
		super(message);
	}
}

interface FlowState {
	/** The user who started the flow, the credential id and the resolved RFC 8707 resource. */
	stateData: { cid: string; userId: string; resource?: string };
	expiresAt: number;
	codeVerifier?: string;
	oauthTokenSecret?: string;
}

const flowKey = (token: string) => `${FLOW_KEY_PREFIX}${token}`;

async function storeFlowState(
	db: D1Database,
	token: string,
	state: Omit<FlowState, 'expiresAt'>,
): Promise<void> {
	const now = Date.now();
	// Flows that nobody finished would pile up, so each new flow clears the expired ones.
	await db
		.prepare(
			"DELETE FROM settings WHERE key LIKE 'oauth:flow:%' AND json_extract(value, '$.expiresAt') < ?",
		)
		.bind(now)
		.run();
	await setSetting(db, flowKey(token), { ...state, expiresAt: now + MAX_CSRF_AGE_MS });
}

async function peekFlowState(db: D1Database, token: string): Promise<FlowState | undefined> {
	const state = await getSetting<FlowState | null>(db, flowKey(token), null);
	return state && state.expiresAt > Date.now() ? state : undefined;
}

/** Reads and deletes the state in one statement, so a state token works once. */
async function consumeFlowState(db: D1Database, token: string): Promise<FlowState | undefined> {
	const row = await db
		.prepare('DELETE FROM settings WHERE key = ? RETURNING value')
		.bind(flowKey(token))
		.first<{ value: string }>();
	if (!row) return undefined;
	const state = jsonParse<FlowState>(row.value, { fallbackValue: undefined });
	return state && state.expiresAt > Date.now() ? state : undefined;
}

const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** The `state` URL parameter holds only a random token. The flow data stays on the server. */
function createState(): { state: string; token: string } {
	const token = base64Url(randomBytes(32));
	return {
		token,
		state: Buffer.from(JSON.stringify({ token, createdAt: Date.now() })).toString('base64url'),
	};
}

function decodeState(encoded: string): string {
	const parsed = jsonParse<{ token?: unknown }>(Buffer.from(encoded, 'base64').toString(), {
		errorMessage: 'Invalid state format',
	});
	if (typeof parsed.token !== 'string') throw new OauthFlowError('Invalid state format', 400);
	return parsed.token;
}

async function pkceChallenge(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64Url(randomBytes(48));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

const baseUrlOf = (rc: Pick<RunContext, 'baseUrl'>, version: 1 | 2) =>
	`${rc.baseUrl}/rest/oauth${version}-credential`;

function validateOAuthUrl(url: string | undefined): void {
	const trimmed = url?.trim();
	if (!trimmed) return;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new OauthFlowError('OAuth url is not a valid URL.', 400);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new OauthFlowError(
			`OAuth url must use HTTP or HTTPS protocol. Invalid protocol: ${parsed.protocol}`,
			400,
		);
	}
}

const text = (data: ICredentialDataDecryptedObject, key: string): string | undefined => {
	const value = data[key];
	return typeof value === 'string' ? value : undefined;
};

type GrantType = 'authorizationCode' | 'clientCredentials' | 'pkce';
type Authentication = 'header' | 'body';

interface OAuth2Config {
	clientId: string;
	clientSecret?: string;
	accessTokenUrl: string;
	authUrl: string;
	scope?: string;
	authQueryParameters?: string;
	additionalBodyProperties?: string;
	authentication: Authentication;
	grantType: GrantType;
	usePkce: boolean;
	ignoreSSLIssues: boolean;
	resource?: string;
	resourceUrl?: string;
	serverUrl?: string;
	useDynamicClientRegistration: boolean;
	jweEnabled: boolean;
	clientAuth: Pick<
		ClientOAuth2Options,
		'clientCredentialType' | 'clientSecret' | 'clientCertificate'
	>;
}

function toOAuth2Config(data: ICredentialDataDecryptedObject): OAuth2Config {
	const grantType = text(data, 'grantType');
	const credentialType = text(data, 'clientCredentialType');
	return {
		clientId: text(data, 'clientId') ?? '',
		clientSecret: text(data, 'clientSecret'),
		accessTokenUrl: text(data, 'accessTokenUrl') ?? '',
		authUrl: text(data, 'authUrl') ?? '',
		scope: text(data, 'scope'),
		authQueryParameters: text(data, 'authQueryParameters'),
		additionalBodyProperties: text(data, 'additionalBodyProperties'),
		authentication: text(data, 'authentication') === 'body' ? 'body' : 'header',
		grantType:
			grantType === 'pkce' || grantType === 'clientCredentials' ? grantType : 'authorizationCode',
		usePkce: data.usePkce === true,
		ignoreSSLIssues: data.ignoreSSLIssues === true,
		resource: text(data, 'resource'),
		resourceUrl: text(data, 'resourceUrl'),
		serverUrl: text(data, 'serverUrl'),
		useDynamicClientRegistration: data.useDynamicClientRegistration === true,
		jweEnabled: data.jweEnabled === true,
		clientAuth: resolveClientAuthOptions({
			clientCredentialType: credentialType === 'certificate' ? 'certificate' : undefined,
			clientSecret: text(data, 'clientSecret'),
			privateKey: text(data, 'privateKey'),
			certificate: text(data, 'certificate'),
		}),
	};
}

function toClientOptions(config: OAuth2Config, redirectUri: string): ClientOAuth2Options {
	const options: ClientOAuth2Options = {
		clientId: config.clientId,
		...config.clientAuth,
		accessTokenUri: config.accessTokenUrl,
		authorizationUri: config.authUrl,
		authentication: config.authentication,
		redirectUri,
		scopes: (config.scope ?? 'openid').split(','),
		scopesSeparator: config.scope?.includes(',') ? ',' : ' ',
		resource: config.resource,
		ignoreSSLIssues: config.ignoreSSLIssues,
	};
	if (config.additionalBodyProperties) {
		const body = jsonParse<Record<string, string>>(config.additionalBodyProperties, {
			fallbackValue: undefined,
		});
		if (body) options.body = body;
	}
	return options;
}

function assertSupported(config: OAuth2Config): void {
	if (config.serverUrl || config.useDynamicClientRegistration) {
		throw new OauthFlowError(
			'OAuth server discovery and dynamic client registration are not supported on this instance.',
			400,
		);
	}
	if (config.jweEnabled)
		throw new OauthFlowError(
			'Encrypted token responses (JWE) are not supported on this instance.',
			400,
		);
}

function hasEditableScopeProperty(type: string): boolean {
	try {
		const scope = CredentialsHelper.credentialsProperties(type).find(
			(property) => property.name === 'scope',
		);
		return scope !== undefined && scope.type !== 'hidden';
	} catch {
		return false;
	}
}

interface LoadedCredential {
	/** Stored data, decrypted, without defaults. */
	original: ICredentialDataDecryptedObject;
	/** Data with defaults, overwrites and expressions applied. */
	resolved: ICredentialDataDecryptedObject;
}

async function loadCredential(
	rc: RunContext,
	userId: string,
	row: CredentialRow,
	forAuthUri: boolean,
): Promise<LoadedCredential> {
	await bootstrap(rc.env);
	await loadCredentialType(row.type);
	const helper = new CredentialsHelper(rc.env.DB);
	const additionalData = await buildAdditionalData(rc.env, { baseUrl: rc.baseUrl, userId });
	const details = { id: row.id, name: row.name };
	const original = await helper.getDecrypted(
		additionalData,
		details,
		row.type,
		'internal',
		undefined,
		true,
	);
	const stored = { ...original };
	if (forAuthUri) {
		// A scope that a past version saved would hide new default scopes on reconnect.
		const userCanEditScope =
			EDITABLE_SCOPE_TYPES.includes(row.type) || hasEditableScopeProperty(row.type);
		if (stored.scope && row.type.includes('OAuth2') && (row.isManaged === 1 || !userCanEditScope))
			delete stored.scope;
	}
	const resolved = await helper.applyDefaultsAndOverwrites(
		additionalData,
		stored,
		row.type,
		'internal',
	);
	return { original, resolved };
}

async function saveTokenData(
	env: Env,
	row: CredentialRow,
	oauthTokenData: ICredentialDataDecryptedObject,
): Promise<void> {
	await new CredentialsHelper(env.DB).updateCredentialsOauthTokenData(
		{ id: row.id, name: row.name },
		row.type,
		{
			oauthTokenData,
		},
	);
}

/** Port of generateAOauth2AuthUri. Returns the URL the editor opens in a popup. */
export async function createOAuth2AuthUri(
	rc: RunContext,
	userId: string,
	row: CredentialRow,
): Promise<string> {
	const { resolved } = await loadCredential(rc, userId, row, true);
	const config = toOAuth2Config(resolved);
	assertSupported(config);

	const stateData: FlowState['stateData'] = { cid: row.id, userId };
	if (config.resourceUrl) {
		const resource = config.resourceUrl.trim().replace(/\/+$/, '');
		validateOAuthUrl(resource);
		config.resource = resource;
		stateData.resource = resource;
	}
	validateOAuthUrl(config.authUrl);
	validateOAuthUrl(config.accessTokenUrl);

	const { state, token } = createState();
	const options: ClientOAuth2Options = {
		...toClientOptions(config, `${baseUrlOf(rc, 2)}/callback`),
		state,
	};
	if (config.authQueryParameters)
		options.query = Object.fromEntries(new URLSearchParams(config.authQueryParameters));

	const flow: Omit<FlowState, 'expiresAt'> = { stateData };
	if (config.grantType === 'pkce' || (config.grantType === 'authorizationCode' && config.usePkce)) {
		const { verifier, challenge } = await pkceChallenge();
		options.query = { ...options.query, code_challenge: challenge, code_challenge_method: 'S256' };
		flow.codeVerifier = verifier;
	}
	await storeFlowState(rc.env.DB, token, flow);
	return new ClientOAuth2(options).code.getUri();
}

export interface CallbackSubject {
	userId: string | undefined;
	/** Whether the user may change the credential. Called with the credential id of the flow. */
	canUpdate: (credentialId: string) => Promise<CredentialRow | null>;
}

/** Port of decodeCsrfState and resolveCredential: the flow has to belong to the signed-in user. */
async function resolveFlow(
	rc: RunContext,
	encodedState: string,
	subject: CallbackSubject,
): Promise<{ row: CredentialRow; flow: FlowState; data: LoadedCredential }> {
	const token = decodeState(encodedState);
	const pending = await peekFlowState(rc.env.DB, token);
	if (!pending) throw new OauthFlowError('The OAuth callback state is invalid!', 400);
	if (subject.userId === undefined || pending.stateData.userId !== subject.userId) {
		throw new OauthFlowError('Unauthorized', 401);
	}
	const row = await subject.canUpdate(pending.stateData.cid);
	if (!row) throw new OauthFlowError('Credential not found', 404);

	const data = await loadCredential(rc, subject.userId, row, false);
	// Consume last, so a request with the wrong user cannot burn the state of another user.
	const flow = await consumeFlowState(rc.env.DB, token);
	if (!flow) throw new OauthFlowError('The OAuth callback state is invalid!', 400);
	return { row, flow, data };
}

/** Port of the callback of OAuth2CredentialController. Exchanges the code and stores the token. */
export async function completeOAuth2Callback(
	rc: RunContext,
	query: Record<string, string>,
	queryString: string,
	subject: CallbackSubject,
): Promise<void> {
	const { code, state } = query;
	if (!code || !state) {
		throw new OauthFlowError(
			'Insufficient parameters for OAuth2 callback.',
			400,
			`Received following query parameters: ${JSON.stringify(query)}`,
		);
	}
	const { row, flow, data } = await resolveFlow(rc, state, subject);
	try {
		await exchangeOAuth2Code(rc, row, flow, data, query, queryString);
	} catch (error) {
		if (!(error instanceof Error) || error instanceof OauthFlowError) throw error;
		const { message, reason } = describeOauthError(error, row.type);
		throw new OauthFlowError(message, 400, reason);
	}
}

async function exchangeOAuth2Code(
	rc: RunContext,
	row: CredentialRow,
	flow: FlowState,
	data: LoadedCredential,
	query: Record<string, string>,
	queryString: string,
): Promise<void> {
	const config = toOAuth2Config(data.resolved);
	assertSupported(config);
	if (typeof flow.stateData.resource === 'string') config.resource = flow.stateData.resource;

	const options = toClientOptions(config, `${baseUrlOf(rc, 2)}/callback`);
	const body: Record<string, string> = { ...(options.body ?? {}) };
	const usesPkce = config.grantType === 'pkce' || config.usePkce;
	if (usesPkce) body.code_verifier = flow.codeVerifier ?? '';
	if (config.authentication === 'body') {
		body.client_id = options.clientId;
		if (options.clientSecret) body.client_secret = options.clientSecret;
		// The code flow would also send the secret in the Authorization header.
		delete options.clientSecret;
	}
	const tokenOptions: Partial<ClientOAuth2Options> =
		usesPkce || config.authentication === 'body' ? { body } : {};

	const oauthToken = await new ClientOAuth2(options).code.getToken(
		`${options.redirectUri}?${queryString}`,
		tokenOptions,
	);
	const tokenResponse: IDataObject = { ...oauthToken.data };
	if (Object.keys(query).length > 2) {
		const { state: _state, code: _code, ...rest } = query;
		tokenResponse.callbackQueryString = rest;
	}

	// Providers like Google return the refresh token only on the first grant, so keep the old one.
	const previous = data.original.oauthTokenData;
	// The token response is parsed JSON, so its values are valid credential data.
	const oauthTokenData = {
		...(isRecord(previous) ? previous : {}),
		...tokenResponse,
	} as ICredentialDataDecryptedObject;
	const expiresInSeconds = Number(tokenResponse.expires_in);
	if (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
		oauthTokenData.n8n_expires_at = String(Date.now() + expiresInSeconds * 1000);
	}
	if (typeof flow.stateData.resource === 'string')
		oauthTokenData.resource = flow.stateData.resource;
	await saveTokenData(rc.env, row, oauthTokenData);
}

/** RFC 3986 percent encoding, which OAuth1 signatures need. */
const percentEncode = (value: string) =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);

const HASHES = { 'HMAC-SHA1': 'sha1', 'HMAC-SHA256': 'sha256', 'HMAC-SHA512': 'sha512' } as const;

interface OAuth1Config {
	signatureMethod: keyof typeof HASHES;
	consumerKey: string;
	consumerSecret: string;
	authUrl: string;
	accessTokenUrl: string;
	requestTokenUrl: string;
}

function toOAuth1Config(data: ICredentialDataDecryptedObject): OAuth1Config {
	const method = text(data, 'signatureMethod');
	return {
		signatureMethod: method === 'HMAC-SHA256' || method === 'HMAC-SHA512' ? method : 'HMAC-SHA1',
		consumerKey: text(data, 'consumerKey') ?? '',
		consumerSecret: text(data, 'consumerSecret') ?? '',
		authUrl: text(data, 'authUrl') ?? '',
		accessTokenUrl: text(data, 'accessTokenUrl') ?? '',
		requestTokenUrl: text(data, 'requestTokenUrl') ?? '',
	};
}

/**
 * RFC 5849 section 3.4 signature. `headerParams` go into the Authorization header and the signature.
 * `bodyParams` are form fields of the body and only go into the signature.
 */
export function signOAuth1Request(
	config: OAuth1Config,
	request: { method: string; url: string },
	token: { key: string; secret: string } | undefined,
	headerParams: Record<string, string>,
	bodyParams: Record<string, string> = {},
	fixed: { nonce?: string; timestamp?: string } = {},
): string {
	const oauth: Record<string, string> = {
		oauth_consumer_key: config.consumerKey,
		oauth_nonce: fixed.nonce ?? base64Url(randomBytes(16)),
		oauth_signature_method: config.signatureMethod,
		oauth_timestamp: fixed.timestamp ?? String(Math.floor(Date.now() / 1000)),
		oauth_version: '1.0',
		...(token ? { oauth_token: token.key } : {}),
		...headerParams,
	};
	const url = new URL(request.url);
	const queryPairs = [...url.searchParams.entries()];
	const pairs = [...queryPairs, ...Object.entries(bodyParams), ...Object.entries(oauth)]
		.map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
		.sort(([ka, va], [kb, vb]) => (ka === kb ? (va < vb ? -1 : va > vb ? 1 : 0) : ka < kb ? -1 : 1))
		.map(([key, value]) => `${key}=${value}`)
		.join('&');
	const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
	const base = [request.method.toUpperCase(), percentEncode(baseUrl), percentEncode(pairs)].join(
		'&',
	);
	const signingKey = `${percentEncode(config.consumerSecret)}&${percentEncode(token?.secret ?? '')}`;
	oauth.oauth_signature = createHmac(HASHES[config.signatureMethod], signingKey)
		.update(base)
		.digest('base64');
	return `OAuth ${Object.entries(oauth)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
		.join(', ')}`;
}

async function formRequest(
	url: string,
	headers: Record<string, string>,
	body?: string,
): Promise<URLSearchParams> {
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			...headers,
			...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
		},
		body,
	});
	const responseText = await response.text();
	if (!response.ok)
		throw new OauthFlowError(`OAuth1 server answered with status ${response.status}`, 400);
	return new URLSearchParams(responseText);
}

/** Port of generateAOauth1AuthUri. */
export async function createOAuth1AuthUri(
	rc: RunContext,
	userId: string,
	row: CredentialRow,
): Promise<string> {
	const { resolved } = await loadCredential(rc, userId, row, true);
	const config = toOAuth1Config(resolved);
	validateOAuthUrl(config.authUrl);
	validateOAuthUrl(config.requestTokenUrl);
	validateOAuthUrl(config.accessTokenUrl);

	const { state, token } = createState();
	const callback = `${baseUrlOf(rc, 1)}/callback?state=${state}`;
	const authorization = signOAuth1Request(
		config,
		{ method: 'POST', url: config.requestTokenUrl },
		undefined,
		{
			oauth_callback: callback,
		},
	);
	const response = await formRequest(config.requestTokenUrl, { authorization });
	const requestToken = response.get('oauth_token');
	if (!requestToken) {
		throw new OauthFlowError(
			'OAuth1 request token response is missing required oauth_token parameter',
			400,
		);
	}

	const authUrl = new URL(config.authUrl);
	authUrl.searchParams.set('oauth_token', requestToken);
	await storeFlowState(rc.env.DB, token, {
		stateData: { cid: row.id, userId },
		oauthTokenSecret: response.get('oauth_token_secret') ?? '',
	});
	return authUrl.toString();
}

/** Port of the callback of OAuth1CredentialController. */
export async function completeOAuth1Callback(
	rc: RunContext,
	query: Record<string, string>,
	subject: CallbackSubject,
): Promise<void> {
	const { oauth_verifier: verifier, oauth_token: requestToken, state } = query;
	if (!verifier || !requestToken || !state) {
		throw new OauthFlowError(
			'Insufficient parameters for OAuth1 callback.',
			400,
			`Received following query parameters: ${JSON.stringify(query)}`,
		);
	}
	const { row, flow, data } = await resolveFlow(rc, state, subject);
	const config = toOAuth1Config(data.resolved);

	const accessTokenRequest = { method: 'POST', url: config.accessTokenUrl };
	const authorization = signOAuth1Request(
		config,
		accessTokenRequest,
		{ key: requestToken, secret: flow.oauthTokenSecret ?? '' },
		{},
		{ oauth_verifier: verifier },
	);
	const response = await formRequest(
		config.accessTokenUrl,
		{ authorization },
		new URLSearchParams({ oauth_verifier: verifier }).toString(),
	);
	await saveTokenData(rc.env, row, Object.fromEntries(response.entries()));
}

/** Whether the credential type sets `accessTokenUrl` to a fixed hidden value, so a user cannot aim the request. */
function hasFixedTokenEndpoint(type: string): boolean {
	try {
		const property = CredentialsHelper.credentialsProperties(type).find(
			(p) => p.name === 'accessTokenUrl',
		);
		return (
			property?.type === 'hidden' &&
			typeof property.default === 'string' &&
			!property.default.startsWith('=')
		);
	} catch {
		return false;
	}
}

/** Heading and reason for the error page. Text that the token server sent shows only for a fixed endpoint. */
export function describeOauthError(
	error: Error,
	credentialType?: string,
): { message: string; reason?: string } {
	if (error instanceof OauthFlowError) return { message: error.message, reason: error.reason };
	if (error instanceof AuthError) {
		const code: unknown = isRecord(error.body) ? error.body.error : undefined;
		const showServerText = credentialType !== undefined && hasFixedTokenEndpoint(credentialType);
		return {
			message:
				error.fromErrorObject && !showServerText
					? 'The OAuth2 server rejected the token request'
					: error.message,
			reason: typeof code === 'string' && code.length > 0 ? code : undefined,
		};
	}
	const causes: string[] = [];
	for (let cause: unknown = error.cause; cause instanceof Error; cause = cause.cause)
		causes.push(cause.message);
	return { message: error.message, reason: causes.length > 0 ? causes.join(': ') : undefined };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
