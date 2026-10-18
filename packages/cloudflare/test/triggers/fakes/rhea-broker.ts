// A tiny AMQP 1.0 broker for tests, built on rhea's own server mode.
import { createRequire } from 'node:module';
import type { Server } from 'node:net';

const nodesBase = createRequire(new URL('../../../../nodes-base/package.json', import.meta.url));

// Only the parts of rhea we use.
interface Link {
	source?: { address?: string };
	target?: { address?: string };
	send(message: { body: unknown }): void;
	is_open(): boolean;
}
interface Context {
	sender?: Link;
	receiver?: Link;
	message?: { body: unknown };
	connection: { close(): void };
}
interface Container {
	on(event: string, cb: (context: Context) => void): void;
	listen(options: { port: number; host: string }): Server;
}
const rhea = nodesBase('rhea') as { create_container(options?: object): Container };

export interface FakeRheaBroker {
	port: number;
	/** Sends a message to the clients that receive from `address`. Waits in a queue when none does. */
	send(address: string, body: string): void;
	/** Bodies that clients sent to `address`. */
	received(address: string): unknown[];
	/** Number of open client receivers on `address`. */
	receivers(address: string): number;
	close(): Promise<void>;
}

export async function startRheaBroker(): Promise<FakeRheaBroker> {
	const container = rhea.create_container({ id: 'fake-broker' });
	const senders = new Map<string, Set<Link>>();
	const queued = new Map<string, string[]>();
	const inbox = new Map<string, unknown[]>();
	const connections = new Set<Context['connection']>();

	const deliver = (address: string) => {
		const links = [...(senders.get(address) ?? [])].filter((link) => link.is_open());
		const waiting = queued.get(address) ?? [];
		while (links.length && waiting.length) links[0].send({ body: waiting.shift() });
	};

	container.on('connection_open', (context) => connections.add(context.connection));
	container.on('connection_close', (context) => connections.delete(context.connection));
	container.on('disconnected', (context) => connections.delete(context.connection));
	// A client receiver attaches to a broker sender. Its source names the address.
	container.on('sender_open', (context) => {
		const address = context.sender?.source?.address ?? '';
		if (!senders.has(address)) senders.set(address, new Set());
		senders.get(address)!.add(context.sender!);
		deliver(address);
	});
	const dropSender = (context: Context) => {
		for (const links of senders.values()) if (context.sender) links.delete(context.sender);
	};
	container.on('sender_close', dropSender);
	container.on('sender_error', dropSender);
	container.on('disconnected', () => {
		for (const links of senders.values())
			for (const link of links) if (!link.is_open()) links.delete(link);
	});
	container.on('message', (context) => {
		const address = context.receiver?.target?.address ?? '';
		if (!inbox.has(address)) inbox.set(address, []);
		inbox.get(address)!.push(context.message?.body);
	});

	const server = container.listen({ port: 0, host: '127.0.0.1' });
	await new Promise<void>((resolve) =>
		server.listening ? resolve() : server.once('listening', resolve),
	);
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;

	return {
		port,
		send(target, body) {
			if (!queued.has(target)) queued.set(target, []);
			queued.get(target)!.push(body);
			deliver(target);
		},
		received: (target) => inbox.get(target) ?? [],
		receivers: (target) => [...(senders.get(target) ?? [])].filter((link) => link.is_open()).length,
		async close() {
			for (const connection of connections) connection.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
