/** Port of OAuth1CredentialController and OAuth2CredentialController (packages/cli/src/controllers/oauth). */
import { Hono } from 'hono';

import { requireUser } from '../../auth/middleware';
import {
	credentialScopes,
	findCredential,
	loadSharings,
	userProjectRoles,
} from '../../db/credentials';
import type { CredentialRow, UserRow } from '../../db/types';
import type { Env } from '../../env';
import {
	completeOAuth1Callback,
	completeOAuth2Callback,
	createOAuth1AuthUri,
	createOAuth2AuthUri,
	describeOauthError,
} from '../../runtime/oauth-flow';
import type { CallbackSubject } from '../../runtime/oauth-flow';
import { ok, runContextOf } from '../app';
import type { AppContext, AppEnv } from '../app';
import { badRequest, notFound } from '../errors';
import { queryParams } from '../http';

export const oauthRoutes = new Hono<AppEnv>();

const NO_CREDENTIAL = 'Credential not found';

/** The credential, when the user may change it. Connecting an account stores the token on the credential. */
async function credentialToConnect(
	env: Env,
	user: Pick<UserRow, 'id' | 'roleSlug'>,
	id: string,
): Promise<CredentialRow | null> {
	const row = await findCredential(env.DB, id);
	if (!row) return null;
	const [sharings, relations] = await Promise.all([
		loadSharings(env.DB, [id]),
		userProjectRoles(env.DB, user.id),
	]);
	return credentialScopes(user, sharings.get(id) ?? [], relations).includes('credential:update')
		? row
		: null;
}

async function credentialForAuth(c: AppContext, user: UserRow): Promise<CredentialRow> {
	const { id } = queryParams(c);
	if (typeof id !== 'string' || id === '') throw badRequest('Required credential ID is missing');
	const row = await credentialToConnect(c.env, user, id);
	if (!row) throw notFound(NO_CREDENTIAL);
	return row;
}

oauthRoutes.get('/oauth2-credential/auth', async (c) => {
	const user = requireUser(c);
	return ok(
		c,
		await createOAuth2AuthUri(runContextOf(c), user.id, await credentialForAuth(c, user)),
	);
});

oauthRoutes.get('/oauth1-credential/auth', async (c) => {
	const user = requireUser(c);
	return ok(
		c,
		await createOAuth1AuthUri(runContextOf(c), user.id, await credentialForAuth(c, user)),
	);
});

const escapeHtml = (value: string) =>
	value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `body { font-family: 'Open Sans', sans-serif; padding: 10px; }
details.error { margin-bottom: 20px; }
pre.reason { background: #f7f7f7; border: 1px solid #ddd; border-radius: 3px; padding: 10px; overflow: auto; overflow-wrap: break-word; white-space: pre-wrap; }`;

/** The page tells the editor through BroadcastChannel and window.opener, like the stock templates. */
function page(
	c: AppContext,
	title: string,
	body: string,
	announce: 'success' | 'error' | null,
): Response {
	const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
	const script =
		announce === null
			? ''
			: `<script nonce="${nonce}">
(function messageParent() {
	const broadcastChannel = new BroadcastChannel('oauth-callback');
	broadcastChannel.postMessage('${announce}');
	try { window.opener?.postMessage('${announce}', '*'); } catch (_) {}
})();
${announce === 'success' ? 'setTimeout(function () { window.close(); }, 5000);' : ''}
</script>`;
	return c.html(
		`<html><head><title>${title}</title><style>${STYLE}</style></head><body>${body}${script}</body></html>`,
		200,
		{
			'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`,
		},
	);
}

const successPage = (c: AppContext) =>
	page(
		c,
		'n8n - OAuth Callback',
		'<h4>Connection successful</h4><p>This window will close automatically in 5 seconds.</p>',
		'success',
	);

function errorPage(c: AppContext, message: string, reason?: string): Response {
	const details = reason ? `<pre class='reason'>${escapeHtml(reason)}</pre>` : '';
	return page(
		c,
		'n8n - OAuth Callback',
		`<h4>Error: ${escapeHtml(message)}</h4><details class='error'><summary>More details</summary>${details}</details>Failed to connect. The window can be closed now.`,
		'error',
	);
}

/** An administrator approving an app for an organisation lands here without a code, and says nothing to the editor. */
function adminConsentPage(c: AppContext): Response {
	return page(
		c,
		'n8n - Administrator consent',
		'<h4>Permissions approved</h4>Everyone in your organisation can now sign in to n8n for this setup. The window can be closed, and the sign-in can be started again.',
		null,
	);
}

function stringQuery(c: AppContext): Record<string, string> {
	return Object.fromEntries(
		Object.entries(queryParams(c)).flatMap(([key, value]) =>
			typeof value === 'string' ? [[key, value]] : [],
		),
	);
}

function subjectOf(c: AppContext): CallbackSubject {
	const user = c.get('user');
	return {
		userId: user?.id,
		canUpdate: async (id) => (user ? await credentialToConnect(c.env, user, id) : null),
	};
}

oauthRoutes.get('/oauth2-credential/callback', async (c) => {
	const query = stringQuery(c);
	if (!query.code || !query.state) {
		if (query.admin_consent) {
			if (query.admin_consent === 'False' || query.error) {
				return errorPage(c, 'The administrator did not approve the requested permissions.');
			}
			return adminConsentPage(c);
		}
	}
	try {
		await completeOAuth2Callback(
			runContextOf(c),
			query,
			new URL(c.req.url).search.slice(1),
			subjectOf(c),
		);
		return successPage(c);
	} catch (error) {
		console.error('OAuth2 callback failed', error);
		const { message, reason } = describeOauthError(
			error instanceof Error ? error : new Error(String(error)),
		);
		return errorPage(c, message, reason);
	}
});

oauthRoutes.get('/oauth1-credential/callback', async (c) => {
	try {
		await completeOAuth1Callback(runContextOf(c), stringQuery(c), subjectOf(c));
		return successPage(c);
	} catch (error) {
		console.error('OAuth1 callback failed', error);
		const { message, reason } = describeOauthError(
			error instanceof Error ? error : new Error(String(error)),
		);
		return errorPage(c, message, reason);
	}
});
