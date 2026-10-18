// A tiny in-process MQTT 3.1.1 / 5 broker for tests, built on mqtt-packet.
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

const nodesBase = createRequire(new URL('../../../../nodes-base/package.json', import.meta.url));
const fromPackage = (name: string) => createRequire(nodesBase.resolve(`${name}/package.json`));

// Only the parts of mqtt-packet we use.
interface MqttPacket {
	cmd: string;
	messageId?: number;
	[key: string]: unknown;
}
interface MqttParser {
	settings: { protocolVersion?: number };
	on(event: 'packet', cb: (packet: MqttPacket) => void): void;
	on(event: 'error', cb: (error: Error) => void): void;
	parse(data: Buffer): number;
}
interface MqttPacketLib {
	parser(opts?: { protocolVersion?: number }): MqttParser;
	generate(packet: Record<string, unknown>, opts?: { protocolVersion?: number }): Buffer;
}

const mqttPacket = fromPackage('mqtt')('mqtt-packet') as MqttPacketLib;

export interface FakeMqttBroker {
	port: number;
	/** Sends a message to every client subscribed to a matching topic. */
	publish(topic: string, payload: string, qos?: 0 | 1): void;
	/** Messages that clients published. */
	published: Array<{ topic: string; payload: string; qos: number }>;
	/** All topic filters clients are subscribed to. */
	subscriptions(): string[];
	/** Number of connected clients. */
	clients(): number;
	/** Usernames from CONNECT packets, in order. */
	usernames: Array<string | undefined>;
	close(): Promise<void>;
}

interface Client {
	socket: Socket;
	protocolVersion: number;
	connected: boolean;
	subs: Map<string, number>;
	nextId: number;
}

/** True when an MQTT topic filter (with + and #) matches a topic. */
export function topicMatches(filter: string, topic: string): boolean {
	const f = filter.split('/');
	const t = topic.split('/');
	for (let i = 0; i < f.length; i++) {
		if (f[i] === '#') return true;
		if (i >= t.length) return false;
		if (f[i] !== '+' && f[i] !== t[i]) return false;
	}
	return f.length === t.length;
}

export async function startMqttBroker(): Promise<FakeMqttBroker> {
	const clients = new Set<Client>();
	const published: FakeMqttBroker['published'] = [];
	const usernames: FakeMqttBroker['usernames'] = [];

	const send = (client: Client, packet: Record<string, unknown>) => {
		if (client.socket.destroyed) return;
		client.socket.write(mqttPacket.generate(packet, { protocolVersion: client.protocolVersion }));
	};

	const deliver = (topic: string, payload: Buffer, qos: number) => {
		for (const client of clients) {
			if (!client.connected) continue;
			let best = -1;
			for (const [filter, subQos] of client.subs) {
				if (topicMatches(filter, topic)) best = Math.max(best, subQos);
			}
			if (best < 0) continue;
			const q = Math.min(qos, best, 1);
			const packet: Record<string, unknown> = {
				cmd: 'publish',
				topic,
				payload,
				qos: q,
				retain: false,
				dup: false,
			};
			if (q > 0) {
				packet.messageId = client.nextId;
				client.nextId = (client.nextId % 65535) + 1;
			}
			send(client, packet);
		}
	};

	const server = createServer((socket) => {
		const parser = mqttPacket.parser();
		const client: Client = {
			socket,
			protocolVersion: 4,
			connected: false,
			subs: new Map(),
			nextId: 1,
		};
		clients.add(client);

		parser.on('packet', (packet) => {
			switch (packet.cmd) {
				case 'connect': {
					client.protocolVersion = (packet.protocolVersion as number) ?? 4;
					// Later packets (with v5 properties) need the right version.
					parser.settings.protocolVersion = client.protocolVersion;
					usernames.push(packet.username as string | undefined);
					client.connected = true;
					send(client, { cmd: 'connack', returnCode: 0, reasonCode: 0, sessionPresent: false });
					break;
				}
				case 'subscribe': {
					const subs = packet.subscriptions as Array<{ topic: string; qos: number }>;
					const granted = subs.map((s) => {
						const q = Math.min(s.qos ?? 0, 1);
						client.subs.set(s.topic, q);
						return q;
					});
					send(client, { cmd: 'suback', messageId: packet.messageId, granted });
					break;
				}
				case 'unsubscribe': {
					const topics = packet.unsubscriptions as string[];
					for (const t of topics) client.subs.delete(t);
					const ack: Record<string, unknown> = { cmd: 'unsuback', messageId: packet.messageId };
					if (client.protocolVersion === 5) ack.granted = topics.map(() => 0);
					send(client, ack);
					break;
				}
				case 'publish': {
					const qos = (packet.qos as number) ?? 0;
					const payload = Buffer.from(packet.payload as Buffer | string);
					const topic = packet.topic as string;
					published.push({ topic, payload: payload.toString(), qos });
					if (qos === 1) send(client, { cmd: 'puback', messageId: packet.messageId });
					if (qos === 2) send(client, { cmd: 'pubrec', messageId: packet.messageId });
					deliver(topic, payload, qos);
					break;
				}
				case 'pubrel':
					send(client, { cmd: 'pubcomp', messageId: packet.messageId });
					break;
				case 'pingreq':
					send(client, { cmd: 'pingresp' });
					break;
				case 'disconnect':
					client.connected = false;
					socket.end();
					break;
				default:
					// puback / pubrec / pubcomp from clients need no reply here.
					break;
			}
		});
		parser.on('error', () => socket.destroy());

		socket.on('data', (data) => parser.parse(data));
		socket.on('error', () => {});
		socket.on('close', () => clients.delete(client));
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});

	return {
		port: (server.address() as AddressInfo).port,
		published,
		usernames,
		publish(topic, payload, qos = 0) {
			deliver(topic, Buffer.from(payload), qos);
		},
		subscriptions() {
			const all = new Set<string>();
			for (const c of clients) for (const t of c.subs.keys()) all.add(t);
			return [...all];
		},
		clients() {
			let n = 0;
			for (const c of clients) if (c.connected) n++;
			return n;
		},
		async close() {
			for (const c of clients) c.socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
