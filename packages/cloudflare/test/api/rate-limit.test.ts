import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Instance, OWNER, startInstance } from './harness';
import type { Session } from './harness';

const WINDOW_MS = 60_000;

/** The binding counts in windows fixed to the wall clock, so a burst must not straddle a boundary. */
async function startOfWindow(minimumLeftMs: number) {
	const left = WINDOW_MS - (Date.now() % WINDOW_MS);
	if (left < minimumLeftMs) await new Promise((resolve) => setTimeout(resolve, left + 100));
}

const login = (session: Session, email: string, password: string) =>
	session.post('/rest/login', { emailOrLdapLoginId: email, password });

describe('login rate limit per email', () => {
	let instance: Instance;
	let session: Session;

	beforeAll(async () => {
		instance = await startInstance({ rateLimit: true });
		session = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('answers the sixth attempt within a minute with 429', async () => {
		await startOfWindow(20_000);
		for (let attempt = 1; attempt <= 5; attempt++) {
			const res = await login(instance.session(), OWNER.email, 'wrong-Password1');
			expect(res.status, `attempt ${attempt}`).toBe(401);
		}
		const blocked = await login(instance.session(), OWNER.email, 'wrong-Password1');
		expect(blocked.status).toBe(429);
		expect(blocked.body).toMatchObject({
			code: 429,
			message: 'Too many requests, please try again later.',
		});
	});

	it('also blocks the right password, and ignores the case of the email', async () => {
		const res = await login(instance.session(), OWNER.email.toUpperCase(), OWNER.password);
		expect(res.status).toBe(429);
	});

	it('keeps other emails working', async () => {
		const res = await login(instance.session(), 'someone-else@example.com', 'wrong-Password1');
		expect(res.status).toBe(401);
	});

	it('limits password changes of one user', async () => {
		const change = () =>
			session.patch('/rest/me/password', {
				currentPassword: 'wrong-Password1',
				newPassword: 'Another-Password2',
			});
		await startOfWindow(20_000);
		for (let attempt = 1; attempt <= 5; attempt++) {
			expect((await change()).status, `attempt ${attempt}`).toBe(400);
		}
		const blocked = await change();
		expect(blocked.status).toBe(429);
		expect(blocked.body).toMatchObject({ message: 'Too many requests, please try again later.' });
	});
});

describe('login rate limit per IP', () => {
	let instance: Instance;

	beforeAll(async () => {
		instance = await startInstance({ rateLimit: true });
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('answers request 201 within a minute with 429', async () => {
		await startOfWindow(40_000);
		const session = instance.session();
		// Each email is new, so only the IP limit can fire. No such user exists, so no password hash is computed.
		const statuses: number[] = [];
		for (let attempt = 1; attempt <= 201; attempt++) {
			statuses.push((await login(session, `user${attempt}@example.com`, 'wrong-Password1')).status);
		}
		expect(statuses.slice(0, 200).every((status) => status === 401)).toBe(true);
		expect(statuses[200]).toBe(429);
		const blocked = await login(session, 'user-last@example.com', 'wrong-Password1');
		expect(blocked.body).toMatchObject({ code: 429, message: 'Too many requests' });
	});
});
