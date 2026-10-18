// A small in-process AMQP 0-9-1 broker for tests. It uses amqplib's own codec.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

const nodesBase = createRequire(new URL('../../../../nodes-base/package.json', import.meta.url));

type Fields = Record<string, unknown>;

// Only the parts of amqplib/lib/defs.js we use.
interface AmqpDefs {
	constants: Record<string, number>;
	decode(id: number, buf: Buffer): Fields;
	encodeMethod(id: number, channel: number, fields: Fields): Buffer;
	encodeProperties(classId: number, channel: number, size: number, fields: Fields): Buffer;
	[method: string]: unknown;
}

const defs = nodesBase('amqplib/lib/defs') as AmqpDefs;
const C = defs.constants;
const id = (name: string) => defs[name] as number;

const PROTOCOL_HEADER = Buffer.from([0x41, 0x4d, 0x51, 0x50, 0, 0, 9, 1]);
const FRAME_MAX = 131072;
const BASIC_CLASS = 60;

export interface FakeAmqpBroker {
	port: number;
	/** Puts a message on a queue; it goes to a consumer when one exists. */
	send(queue: string, body: string, properties?: Record<string, unknown>): void;
	/** Creates an empty queue, as an operator does before clients check for it. */
	declare(queue: string): void;
	/** Bodies of messages acked / nacked (or rejected) by clients, in order. */
	acked: string[];
	nacked: string[];
	/** Messages clients published. */
	published: Array<{
		exchange: string;
		routingKey: string;
		body: string;
		properties: Record<string, unknown>;
	}>;
	/** Number of consumers on a queue. */
	consumers(queue: string): number;
	/** Messages waiting in a queue (not delivered). */
	depth(queue: string): number;
	close(): Promise<void>;
}

interface Message {
	exchange: string;
	routingKey: string;
	body: Buffer;
	properties: Fields;
	redelivered: boolean;
}

interface Consumer {
	tag: string;
	channel: Channel;
	noAck: boolean;
}

interface Queue {
	name: string;
	messages: Message[];
	consumers: Consumer[];
	next: number;
}

interface Exchange {
	type: string;
	bindings: Array<{ queue: string; key: string }>;
}

interface PendingContent {
	exchange: string;
	routingKey: string;
	size: number;
	properties: Fields;
	chunks: Buffer[];
	received: number;
	gotHeader: boolean;
}

interface Channel {
	id: number;
	conn: Conn;
	prefetch: number;
	confirm: boolean;
	publishSeq: number;
	nextTag: number;
	unacked: Map<number, { queue: string; message: Message }>;
	consumers: Map<string, Consumer>;
	content?: PendingContent;
	closing: boolean;
}

interface Conn {
	socket: Socket;
	buffer: Buffer;
	gotHeader: boolean;
	frameMax: number;
	channels: Map<number, Channel>;
}

/** Topic match: `*` is one word, `#` is zero or more words. */
function topicMatches(pattern: string, key: string): boolean {
	const p = pattern.split('.');
	const k = key.split('.');
	const match = (i: number, j: number): boolean => {
		if (i === p.length) return j === k.length;
		if (p[i] === '#') {
			for (let n = j; n <= k.length; n++) if (match(i + 1, n)) return true;
			return false;
		}
		if (j === k.length) return false;
		return (p[i] === '*' || p[i] === k[j]) && match(i + 1, j + 1);
	};
	return match(0, 0);
}

/** Removes undefined values so the record is easy to compare in tests. */
function clean(fields: Fields): Fields {
	const out: Fields = {};
	for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
	return out;
}

export async function startAmqpBroker(): Promise<FakeAmqpBroker> {
	const queues = new Map<string, Queue>();
	const exchanges = new Map<string, Exchange>([
		['', { type: 'direct', bindings: [] }],
		['amq.direct', { type: 'direct', bindings: [] }],
		['amq.fanout', { type: 'fanout', bindings: [] }],
		['amq.topic', { type: 'topic', bindings: [] }],
		['amq.headers', { type: 'headers', bindings: [] }],
	]);
	const conns = new Set<Conn>();
	const acked: string[] = [];
	const nacked: string[] = [];
	const published: FakeAmqpBroker['published'] = [];

	const getQueue = (name: string): Queue => {
		let q = queues.get(name);
		if (!q) {
			q = { name, messages: [], consumers: [], next: 0 };
			queues.set(name, q);
		}
		return q;
	};

	const write = (conn: Conn, buf: Buffer) => {
		if (!conn.socket.destroyed) conn.socket.write(buf);
	};
	const sendMethod = (ch: Channel | Conn, channel: number, name: string, fields: Fields = {}) => {
		const conn = 'conn' in ch ? ch.conn : ch;
		write(conn, defs.encodeMethod(id(name), channel, fields));
	};
	const sendContent = (ch: Channel, body: Buffer, properties: Fields) => {
		const conn = ch.conn;
		write(conn, defs.encodeProperties(BASIC_CLASS, ch.id, body.length, properties));
		const max = conn.frameMax - 8;
		for (let off = 0; off < body.length; off += max) {
			const part = body.subarray(off, off + max);
			const frame = Buffer.alloc(part.length + 8);
			frame.writeUInt8(C.FRAME_BODY, 0);
			frame.writeUInt16BE(ch.id, 1);
			frame.writeUInt32BE(part.length, 3);
			part.copy(frame, 7);
			frame.writeUInt8(C.FRAME_END, part.length + 7);
			write(conn, frame);
		}
	};

	// Sends waiting messages to consumers that have room (round robin).
	const dispatch = (q: Queue) => {
		while (q.messages.length > 0) {
			const n = q.consumers.length;
			let picked: Consumer | undefined;
			for (let i = 0; i < n; i++) {
				const c = q.consumers[(q.next + i) % n];
				const ch = c.channel;
				if (ch.closing) continue;
				if (c.noAck || ch.prefetch === 0 || ch.unacked.size < ch.prefetch) {
					picked = c;
					q.next = (q.next + i + 1) % n;
					break;
				}
			}
			if (!picked) return;
			const message = q.messages.shift()!;
			const ch = picked.channel;
			const tag = ch.nextTag++;
			if (!picked.noAck) ch.unacked.set(tag, { queue: q.name, message });
			sendMethod(ch, ch.id, 'BasicDeliver', {
				consumerTag: picked.tag,
				deliveryTag: tag,
				redelivered: message.redelivered,
				exchange: message.exchange,
				routingKey: message.routingKey,
			});
			sendContent(ch, message.body, message.properties);
		}
	};

	const enqueue = (name: string, message: Message) => {
		const q = getQueue(name);
		q.messages.push(message);
		dispatch(q);
	};

	// Headers exchanges act like fanout here.
	const route = (exchange: string, routingKey: string): string[] => {
		if (exchange === '') return queues.has(routingKey) ? [routingKey] : [];
		const ex = exchanges.get(exchange);
		if (!ex) return [];
		const out = new Set<string>();
		for (const b of ex.bindings) {
			if (ex.type === 'fanout' || ex.type === 'headers') out.add(b.queue);
			else if (ex.type === 'topic' ? topicMatches(b.key, routingKey) : b.key === routingKey)
				out.add(b.queue);
		}
		return [...out];
	};

	// Takes acked/nacked messages off a channel. Tag 0 with multiple means all.
	const settle = (ch: Channel, tag: number, multiple: boolean, into: string[]) => {
		const tags = multiple
			? [...ch.unacked.keys()].filter((t) => tag === 0 || t <= tag).sort((a, b) => a - b)
			: [tag];
		const touched = new Set<string>();
		for (const t of tags) {
			const entry = ch.unacked.get(t);
			if (!entry) continue;
			ch.unacked.delete(t);
			into.push(entry.message.body.toString());
			touched.add(entry.queue);
		}
		for (const name of touched) dispatch(getQueue(name));
	};

	// Puts unacked messages back on their queues, like RabbitMQ does on close.
	const dropChannel = (ch: Channel) => {
		ch.closing = true;
		for (const c of ch.consumers.values()) {
			for (const q of queues.values()) q.consumers = q.consumers.filter((x) => x !== c);
		}
		ch.consumers.clear();
		const back = [...ch.unacked.entries()].sort((a, b) => b[0] - a[0]);
		ch.unacked.clear();
		const touched = new Set<string>();
		for (const [, { queue, message }] of back) {
			message.redelivered = true;
			getQueue(queue).messages.unshift(message);
			touched.add(queue);
		}
		ch.conn.channels.delete(ch.id);
		for (const name of touched) dispatch(getQueue(name));
	};

	// Closes a channel with an error, as RabbitMQ does for a missing queue.
	const channelError = (ch: Channel, code: number, text: string, method: number) => {
		sendMethod(ch, ch.id, 'ChannelClose', {
			replyCode: code,
			replyText: text,
			classId: Math.floor(method / 65536),
			methodId: method % 65536,
		});
		dropChannel(ch);
		ch.closing = true;
		// Keep a stub so the CloseOk from the client is accepted.
		ch.conn.channels.set(ch.id, ch);
	};

	const onPublishDone = (ch: Channel, content: PendingContent) => {
		const body = Buffer.concat(content.chunks);
		const properties = clean(content.properties);
		published.push({
			exchange: content.exchange,
			routingKey: content.routingKey,
			body: body.toString(),
			properties,
		});
		for (const name of route(content.exchange, content.routingKey)) {
			enqueue(name, {
				exchange: content.exchange,
				routingKey: content.routingKey,
				body,
				properties,
				redelivered: false,
			});
		}
		if (ch.confirm) {
			sendMethod(ch, ch.id, 'BasicAck', { deliveryTag: ch.publishSeq++, multiple: false });
		}
	};

	const onMethod = (conn: Conn, channel: number, method: number, f: Fields) => {
		if (channel === 0) {
			switch (method) {
				case id('ConnectionStartOk'):
					sendMethod(conn, 0, 'ConnectionTune', {
						channelMax: 2047,
						frameMax: FRAME_MAX,
						heartbeat: 0,
					});
					return;
				case id('ConnectionTuneOk'):
					conn.frameMax = Math.min((f.frameMax as number) || FRAME_MAX, FRAME_MAX);
					return;
				case id('ConnectionOpen'):
					sendMethod(conn, 0, 'ConnectionOpenOk', { knownHosts: '' });
					return;
				case id('ConnectionClose'):
					for (const ch of [...conn.channels.values()]) dropChannel(ch);
					sendMethod(conn, 0, 'ConnectionCloseOk');
					conn.socket.end();
					return;
				case id('ConnectionCloseOk'):
					conn.socket.end();
					return;
				default:
					return;
			}
		}

		if (method === id('ChannelOpen')) {
			conn.channels.set(channel, {
				id: channel,
				conn,
				prefetch: 0,
				confirm: false,
				publishSeq: 1,
				nextTag: 1,
				unacked: new Map(),
				consumers: new Map(),
				closing: false,
			});
			sendMethod(conn, channel, 'ChannelOpenOk', { channelId: Buffer.alloc(0) });
			return;
		}

		const ch = conn.channels.get(channel);
		if (!ch) return;
		if (method === id('ChannelCloseOk')) {
			conn.channels.delete(channel);
			return;
		}
		if (method === id('ChannelClose')) {
			dropChannel(ch);
			sendMethod(conn, channel, 'ChannelCloseOk');
			return;
		}
		if (ch.closing) return;
		const nowait = f.nowait === true;

		switch (method) {
			case id('QueueDeclare'): {
				const name = (f.queue as string) || `amq.gen-${randomUUID()}`;
				if (f.passive && !queues.has(name)) {
					channelError(ch, C.NOT_FOUND, `NOT_FOUND - no queue '${name}'`, method);
					return;
				}
				const q = getQueue(name);
				if (!nowait) {
					sendMethod(ch, channel, 'QueueDeclareOk', {
						queue: name,
						messageCount: q.messages.length,
						consumerCount: q.consumers.length,
					});
				}
				return;
			}
			case id('QueueBind'): {
				const exName = f.exchange as string;
				const ex = exchanges.get(exName);
				if (!ex) {
					channelError(ch, C.NOT_FOUND, `NOT_FOUND - no exchange '${exName}'`, method);
					return;
				}
				const queue = f.queue as string;
				const key = f.routingKey as string;
				getQueue(queue);
				if (!ex.bindings.some((b) => b.queue === queue && b.key === key)) {
					ex.bindings.push({ queue, key });
				}
				if (!nowait) sendMethod(ch, channel, 'QueueBindOk');
				return;
			}
			case id('QueueUnbind'): {
				const ex = exchanges.get(f.exchange as string);
				if (ex) {
					ex.bindings = ex.bindings.filter((b) => !(b.queue === f.queue && b.key === f.routingKey));
				}
				sendMethod(ch, channel, 'QueueUnbindOk');
				return;
			}
			case id('QueuePurge'): {
				const q = getQueue(f.queue as string);
				const messageCount = q.messages.length;
				q.messages = [];
				if (!nowait) sendMethod(ch, channel, 'QueuePurgeOk', { messageCount });
				return;
			}
			case id('QueueDelete'): {
				const name = f.queue as string;
				const messageCount = queues.get(name)?.messages.length ?? 0;
				queues.delete(name);
				for (const ex of exchanges.values())
					ex.bindings = ex.bindings.filter((b) => b.queue !== name);
				if (!nowait) sendMethod(ch, channel, 'QueueDeleteOk', { messageCount });
				return;
			}
			case id('ExchangeDeclare'): {
				const name = f.exchange as string;
				if (f.passive && !exchanges.has(name)) {
					channelError(ch, C.NOT_FOUND, `NOT_FOUND - no exchange '${name}'`, method);
					return;
				}
				if (!exchanges.has(name)) {
					exchanges.set(name, { type: (f.type as string) || 'direct', bindings: [] });
				}
				if (!nowait) sendMethod(ch, channel, 'ExchangeDeclareOk');
				return;
			}
			case id('ExchangeDelete'):
				exchanges.delete(f.exchange as string);
				if (!nowait) sendMethod(ch, channel, 'ExchangeDeleteOk');
				return;
			case id('ExchangeBind'):
				if (!nowait) sendMethod(ch, channel, 'ExchangeBindOk');
				return;
			case id('ExchangeUnbind'):
				if (!nowait) sendMethod(ch, channel, 'ExchangeUnbindOk');
				return;
			case id('BasicQos'):
				ch.prefetch = (f.prefetchCount as number) ?? 0;
				sendMethod(ch, channel, 'BasicQosOk');
				for (const q of queues.values()) dispatch(q);
				return;
			case id('ConfirmSelect'):
				ch.confirm = true;
				if (!nowait) sendMethod(ch, channel, 'ConfirmSelectOk');
				return;
			case id('BasicConsume'): {
				const queue = f.queue as string;
				if (!queues.has(queue)) {
					channelError(ch, C.NOT_FOUND, `NOT_FOUND - no queue '${queue}'`, method);
					return;
				}
				const tag = (f.consumerTag as string) || `amq.ctag-${randomUUID()}`;
				const consumer: Consumer = { tag, channel: ch, noAck: f.noAck === true };
				ch.consumers.set(tag, consumer);
				const q = getQueue(queue);
				q.consumers.push(consumer);
				if (!nowait) sendMethod(ch, channel, 'BasicConsumeOk', { consumerTag: tag });
				dispatch(q);
				return;
			}
			case id('BasicCancel'): {
				const tag = f.consumerTag as string;
				const consumer = ch.consumers.get(tag);
				ch.consumers.delete(tag);
				if (consumer) {
					for (const q of queues.values()) q.consumers = q.consumers.filter((c) => c !== consumer);
				}
				if (!nowait) sendMethod(ch, channel, 'BasicCancelOk', { consumerTag: tag });
				return;
			}
			case id('BasicGet'): {
				const queue = f.queue as string;
				if (!queues.has(queue)) {
					channelError(ch, C.NOT_FOUND, `NOT_FOUND - no queue '${queue}'`, method);
					return;
				}
				const q = getQueue(queue);
				const message = q.messages.shift();
				if (!message) {
					sendMethod(ch, channel, 'BasicGetEmpty', { clusterId: '' });
					return;
				}
				const tag = ch.nextTag++;
				if (f.noAck !== true) ch.unacked.set(tag, { queue, message });
				sendMethod(ch, channel, 'BasicGetOk', {
					deliveryTag: tag,
					redelivered: message.redelivered,
					exchange: message.exchange,
					routingKey: message.routingKey,
					messageCount: q.messages.length,
				});
				sendContent(ch, message.body, message.properties);
				return;
			}
			case id('BasicAck'):
				settle(ch, f.deliveryTag as number, f.multiple === true, acked);
				return;
			case id('BasicNack'):
				// Nacked messages are dropped, not requeued, so tests do not loop.
				settle(ch, f.deliveryTag as number, f.multiple === true, nacked);
				return;
			case id('BasicReject'):
				settle(ch, f.deliveryTag as number, false, nacked);
				return;
			case id('BasicRecover'):
				sendMethod(ch, channel, 'BasicRecoverOk');
				return;
			case id('BasicPublish'):
				ch.content = {
					exchange: (f.exchange as string) ?? '',
					routingKey: (f.routingKey as string) ?? '',
					size: 0,
					properties: {},
					chunks: [],
					received: 0,
					gotHeader: false,
				};
				return;
			default:
				return;
		}
	};

	const onFrame = (conn: Conn, type: number, channel: number, payload: Buffer) => {
		if (type === C.FRAME_HEARTBEAT) {
			write(conn, Buffer.from([C.FRAME_HEARTBEAT, 0, 0, 0, 0, 0, 0, C.FRAME_END]));
			return;
		}
		if (type === C.FRAME_METHOD) {
			const method = payload.readUInt32BE(0);
			onMethod(conn, channel, method, defs.decode(method, payload.subarray(4)));
			return;
		}
		const ch = conn.channels.get(channel);
		const content = ch?.content;
		if (!ch || !content) return;
		if (type === C.FRAME_HEADER) {
			content.size = Number(payload.readBigUInt64BE(4));
			content.properties = defs.decode(payload.readUInt16BE(0), payload.subarray(12));
			content.gotHeader = true;
		} else if (type === C.FRAME_BODY) {
			content.chunks.push(Buffer.from(payload));
			content.received += payload.length;
		}
		if (content.gotHeader && content.received >= content.size) {
			ch.content = undefined;
			onPublishDone(ch, content);
		}
	};

	const onData = (conn: Conn, data: Buffer) => {
		conn.buffer = conn.buffer.length ? Buffer.concat([conn.buffer, data]) : data;
		if (!conn.gotHeader) {
			if (conn.buffer.length < 8) return;
			const header = conn.buffer.subarray(0, 8);
			conn.buffer = conn.buffer.subarray(8);
			if (!header.equals(PROTOCOL_HEADER)) {
				conn.socket.end(PROTOCOL_HEADER);
				return;
			}
			conn.gotHeader = true;
			sendMethod(conn, 0, 'ConnectionStart', {
				versionMajor: 0,
				versionMinor: 9,
				serverProperties: {
					product: 'fake-amqp',
					version: '0.0.0',
					capabilities: {
						publisher_confirms: true,
						'basic.nack': true,
						consumer_cancel_notify: true,
						exchange_exchange_bindings: true,
						'connection.blocked': true,
						authentication_failure_close: true,
						per_consumer_qos: true,
					},
				},
				mechanisms: Buffer.from('PLAIN AMQPLAIN EXTERNAL'),
				locales: Buffer.from('en_US'),
			});
		}
		// Frame: type(1) channel(2) size(4) payload(size) end(1, 0xCE).
		while (conn.buffer.length >= 7) {
			const size = conn.buffer.readUInt32BE(3);
			if (conn.buffer.length < size + 8) return;
			const type = conn.buffer.readUInt8(0);
			const channel = conn.buffer.readUInt16BE(1);
			const payload = conn.buffer.subarray(7, 7 + size);
			if (conn.buffer[7 + size] !== C.FRAME_END) {
				conn.socket.destroy();
				return;
			}
			conn.buffer = conn.buffer.subarray(size + 8);
			onFrame(conn, type, channel, payload);
		}
	};

	const server = createServer((socket) => {
		const conn: Conn = {
			socket,
			buffer: Buffer.alloc(0),
			gotHeader: false,
			frameMax: FRAME_MAX,
			channels: new Map(),
		};
		conns.add(conn);
		socket.on('data', (data) => {
			try {
				onData(conn, data);
			} catch {
				socket.destroy();
			}
		});
		socket.on('error', () => {});
		socket.on('close', () => {
			for (const ch of [...conn.channels.values()]) dropChannel(ch);
			conns.delete(conn);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});

	return {
		port: (server.address() as AddressInfo).port,
		acked,
		nacked,
		published,
		declare(queue) {
			getQueue(queue);
		},
		send(queue, body, properties = {}) {
			enqueue(queue, {
				exchange: '',
				routingKey: queue,
				body: Buffer.from(body),
				properties: clean(properties),
				redelivered: false,
			});
		},
		consumers(queue) {
			return queues.get(queue)?.consumers.length ?? 0;
		},
		depth(queue) {
			return queues.get(queue)?.messages.length ?? 0;
		},
		async close() {
			for (const c of conns) c.socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
