import { DurableObject } from 'cloudflare:workers';
import { jsonStringify } from 'n8n-workflow';

import type { Env } from '../env';

export interface PushMessage {
	type: string;
	data: unknown;
}

const userTag = (userId: string) => `user:${userId}`;
const refTag = (pushRef: string) => `ref:${pushRef}`;

/**
 * Holds the editor push connections (stock n8n's WebSocketPush). It uses hibernatable
 * WebSockets, so idle editors cost nothing. One instance serves the whole n8n instance.
 */
export class PushHub extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pushRef = url.searchParams.get('pushRef');
		const userId = url.searchParams.get('userId');
		if (request.headers.get('Upgrade') !== 'websocket' || !pushRef || !userId) {
			return new Response('Expected a WebSocket upgrade with pushRef and userId', { status: 400 });
		}

		// A new connection with the same pushRef replaces the old one, like stock n8n.
		for (const old of this.ctx.getWebSockets(refTag(pushRef))) old.close(1000, 'Replaced');

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, [refTag(pushRef), userTag(userId)]);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Editors only send heartbeats, which need no reply. */
	async webSocketMessage(): Promise<void> {}

	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		ws.close(code === 1005 ? 1000 : code, 'Closed');
	}

	async send(message: PushMessage, pushRef: string, asBinary = false): Promise<void> {
		this.sendToSockets(this.ctx.getWebSockets(refTag(pushRef)), message, asBinary);
	}

	async sendToUsers(message: PushMessage, userIds: string[]): Promise<void> {
		for (const userId of userIds) {
			this.sendToSockets(this.ctx.getWebSockets(userTag(userId)), message, false);
		}
	}

	async sendToAll(message: PushMessage): Promise<void> {
		this.sendToSockets(this.ctx.getWebSockets(), message, false);
	}

	async hasConnection(pushRef: string): Promise<boolean> {
		return this.ctx.getWebSockets(refTag(pushRef)).length > 0;
	}

	private sendToSockets(sockets: WebSocket[], message: PushMessage, asBinary: boolean) {
		if (sockets.length === 0) return;
		const payload = jsonStringify(message, { replaceCircularRefs: true });
		// The editor reads binary frames as ArrayBuffer and hands them to a web worker.
		const frame = asBinary ? new TextEncoder().encode(payload) : payload;
		for (const ws of sockets) {
			try {
				ws.send(frame);
			} catch {
				// The socket closed between lookup and send.
			}
		}
	}
}

export const pushHub = (env: Env) => env.PUSH.get(env.PUSH.idFromName('global'));
