import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Instance } from '../api/harness';
import { OWNER, startInstance } from '../api/harness';

describe('browser-id binding', () => {
	let instance: Instance;
	beforeAll(async () => {
		instance = await startInstance();
		await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	// <img>, <embed> and window.open cannot send the browser-id header, like stock exempts.
	it('lets binary-data requests through without the browser-id header and keeps the session', async () => {
		const session = instance.session();
		const login = await session.request(
			'POST',
			'/rest/login',
			{ emailOrLdapLoginId: OWNER.email, password: OWNER.password },
			{ 'browser-id': 'browser-123' },
		);
		expect(login.status).toBe(200);

		const binary = await session.get('/rest/binary-data?id=s3:../escape&action=view');
		expect(binary.status).not.toBe(401);
		expect(session.hasCookie).toBe(true);

		const other = await session.get('/rest/workflows');
		expect(other.status).toBe(401);
	});
});
