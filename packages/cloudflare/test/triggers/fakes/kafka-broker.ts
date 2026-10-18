// A tiny in-process Kafka broker for tests, built on kafkajs's own protocol code.
// It speaks just enough of the protocol for a kafkajs 2.2.4 producer and consumer group.
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

const nodesBase = createRequire(new URL('../../../../nodes-base/package.json', import.meta.url));
const kafkaRequire = createRequire(nodesBase.resolve('kafkajs/package.json'));

// Only the parts of kafkajs's encoder and decoder we use.
interface Encoder {
	buffer: Buffer;
	size(): number;
	writeInt8(v: number): Encoder;
	writeInt16(v: number): Encoder;
	writeInt32(v: number): Encoder;
	writeInt64(v: bigint | number | string): Encoder;
	writeString(v: string | null): Encoder;
	writeBytes(v: Buffer | null): Encoder;
	writeArray(items: Encoder[] | number[]): Encoder;
	writeEncoder(e: Encoder): Encoder;
}
interface Decoder {
	offset: number;
	buffer: Buffer;
	readInt8(): number;
	readInt16(): number;
	readInt32(): number;
	readInt64(): bigint;
	readString(): string | null;
	readBytes(): Buffer;
	readArray<T>(reader: (d: Decoder) => T): T[];
	canReadBytes(n: number): boolean;
}
interface DecodedRecord {
	key: Buffer | null;
	value: Buffer | null;
	headers: Record<string, Buffer | Buffer[]>;
}

const lib = (path: string) => kafkaRequire(`kafkajs/src/${path}`);
const EncoderClass = lib('protocol/encoder') as new () => Encoder;
const DecoderClass = lib('protocol/decoder') as new (buf: Buffer) => Decoder;
const Long = lib('utils/long') as { fromValue(v: bigint | number | string): unknown };
const { RecordBatch } = lib('protocol/recordBatch/v0') as {
	RecordBatch(opts: Record<string, unknown>): Promise<Encoder>;
};
const Record = lib('protocol/recordBatch/record/v0') as (opts: Record<string, unknown>) => Encoder;
const decodeRecordBatch = lib('protocol/recordBatch/v0/decoder') as (
	d: Decoder,
) => Promise<{ records: DecodedRecord[] }>;

const enc = () => new EncoderClass();

// Api keys we handle, with the one version we advertise for each.
// These are the lowest versions kafkajs supports that still carry record headers.
const API = {
	Produce: { key: 0, min: 3, max: 3 },
	Fetch: { key: 1, min: 4, max: 4 },
	ListOffsets: { key: 2, min: 0, max: 0 },
	Metadata: { key: 3, min: 0, max: 0 },
	OffsetCommit: { key: 8, min: 2, max: 2 },
	OffsetFetch: { key: 9, min: 1, max: 1 },
	FindCoordinator: { key: 10, min: 0, max: 0 },
	JoinGroup: { key: 11, min: 0, max: 0 },
	Heartbeat: { key: 12, min: 0, max: 0 },
	LeaveGroup: { key: 13, min: 0, max: 0 },
	SyncGroup: { key: 14, min: 0, max: 0 },
	ApiVersions: { key: 18, min: 0, max: 2 },
};

// Kafka error codes we return.
const ERR = {
	NONE: 0,
	OFFSET_OUT_OF_RANGE: 1,
	UNKNOWN_TOPIC_OR_PARTITION: 3,
	ILLEGAL_GENERATION: 22,
	UNKNOWN_MEMBER_ID: 25,
	REBALANCE_IN_PROGRESS: 27,
};

export interface FakeKafkaBroker {
	port: number;
	/** Appends a record to partition 0 of the topic, for consumers to fetch. */
	produce(topic: string, value: string, key?: string, headers?: Record<string, string>): void;
	/** Records that clients produced, in order. */
	produced: Array<{
		topic: string;
		partition: number;
		key: string | null;
		value: string | null;
		headers: Record<string, string>;
	}>;
	/** Committed offset of a group for topic partition 0, or undefined. */
	committed(groupId: string, topic: string): bigint | number | undefined;
	/** Number of current members of a consumer group. */
	groupMembers(groupId: string): number;
	close(): Promise<void>;
}

interface StoredRecord {
	key: Buffer | null;
	value: Buffer | null;
	headers: Record<string, Buffer>;
	timestamp: number;
}

interface Member {
	metadata: Buffer;
	sessionTimeout: number;
	lastSeen: number;
}

interface Group {
	generation: number;
	protocol: string;
	leader: string;
	members: Map<string, Member>;
	/** True while members must rejoin. */
	rebalancing: boolean;
	/** Join requests waiting for the other members to rejoin. */
	pendingJoins: Map<string, () => void>;
	joinTimer?: NodeJS.Timeout;
	assignments: Map<string, Buffer>;
	/** Sync requests from followers waiting for the leader's assignment. */
	pendingSyncs: Array<() => void>;
	offsets: Map<string, bigint>;
}

type Reply = (body: Encoder) => void;

export async function startKafkaBroker(): Promise<FakeKafkaBroker> {
	const logs = new Map<string, StoredRecord[]>();
	const groups = new Map<string, Group>();
	const produced: FakeKafkaBroker['produced'] = [];
	const sockets = new Set<Socket>();
	// Fetch requests waiting for new records. Each one is woken with the topic that grew.
	const fetchWaiters = new Set<(topic: string | null) => void>();
	let port = 0;
	let nextMemberId = 1;

	const log = (topic: string) => {
		let records = logs.get(topic);
		if (!records) logs.set(topic, (records = []));
		return records;
	};

	const append = (topic: string, record: StoredRecord) => {
		log(topic).push(record);
		for (const wake of [...fetchWaiters]) wake(topic);
	};

	const group = (id: string) => {
		let g = groups.get(id);
		if (!g) {
			g = {
				generation: 0,
				protocol: '',
				leader: '',
				members: new Map(),
				rebalancing: false,
				pendingJoins: new Map(),
				assignments: new Map(),
				pendingSyncs: [],
				offsets: new Map(),
			};
			groups.set(id, g);
		}
		return g;
	};

	// Drops members that stopped sending heartbeats.
	const expireMembers = (g: Group) => {
		const now = Date.now();
		for (const [id, m] of g.members) {
			if (!g.pendingJoins.has(id) && now - m.lastSeen > m.sessionTimeout) {
				g.members.delete(id);
				g.rebalancing = true;
			}
		}
	};

	// Finishes a rebalance once every member has rejoined (or when forced by the timer).
	const completeJoin = (g: Group, force = false) => {
		if (g.pendingJoins.size === 0) return;
		if (!force && [...g.members.keys()].some((id) => !g.pendingJoins.has(id))) return;
		for (const id of g.members.keys()) if (!g.pendingJoins.has(id)) g.members.delete(id);
		clearTimeout(g.joinTimer);
		g.generation++;
		g.leader = [...g.pendingJoins.keys()][0];
		g.rebalancing = false;
		g.assignments.clear();
		const waiting = [...g.pendingJoins.values()];
		g.pendingJoins.clear();
		for (const respond of waiting) respond();
	};

	// One handler per api key. Each reads the request body and calls reply once.
	const handlers: Record<
		number,
		(d: Decoder, version: number, reply: Reply) => void | Promise<void>
	> = {
		[API.ApiVersions.key]: (_d, version, reply) => {
			const versions = Object.values(API).map((a) =>
				enc().writeInt16(a.key).writeInt16(a.min).writeInt16(a.max),
			);
			const body = enc().writeInt16(ERR.NONE).writeArray(versions);
			if (version >= 1) body.writeInt32(0);
			reply(body);
		},

		[API.Metadata.key]: (d, _v, reply) => {
			const requested = d.readArray((r) => r.readString() as string);
			// Requested topics are created on the fly. An empty list means all topics.
			for (const topic of requested) log(topic);
			const topics = requested.length > 0 ? requested : [...logs.keys()];
			const broker = enc().writeInt32(0).writeString('127.0.0.1').writeInt32(port);
			const partition = enc()
				.writeInt16(ERR.NONE)
				.writeInt32(0)
				.writeInt32(0)
				.writeArray([0])
				.writeArray([0]);
			const topicMeta = topics.map((t) =>
				enc().writeInt16(ERR.NONE).writeString(t).writeArray([partition]),
			);
			reply(enc().writeArray([broker]).writeArray(topicMeta));
		},

		[API.Produce.key]: async (d, _v, reply) => {
			d.readString(); // transactional id
			const acks = d.readInt16();
			d.readInt32(); // timeout
			const topics: Encoder[] = [];
			for (const { topic, partitions } of d.readArray((t) => ({
				topic: t.readString() as string,
				partitions: t.readArray((p) => ({ partition: p.readInt32(), records: p.readBytes() })),
			}))) {
				const results: Encoder[] = [];
				for (const { partition, records } of partitions) {
					const baseOffset = log(topic).length;
					const batches = new DecoderClass(records);
					while (batches.canReadBytes(1)) {
						const batch = await decodeRecordBatch(batches);
						for (const r of batch.records) {
							const headers: Record<string, Buffer> = {};
							for (const [k, v] of Object.entries(r.headers)) {
								headers[k] = Array.isArray(v) ? v[v.length - 1] : v;
							}
							produced.push({
								topic,
								partition,
								key: r.key ? r.key.toString() : null,
								value: r.value ? r.value.toString() : null,
								headers: Object.fromEntries(
									Object.entries(headers).map(([k, v]) => [k, v.toString()]),
								),
							});
							append(topic, { key: r.key, value: r.value, headers, timestamp: Date.now() });
						}
					}
					results.push(
						enc().writeInt32(partition).writeInt16(ERR.NONE).writeInt64(baseOffset).writeInt64(-1),
					);
				}
				topics.push(enc().writeString(topic).writeArray(results));
			}
			// With acks=0 the client expects no response.
			if (acks !== 0) reply(enc().writeArray(topics).writeInt32(0));
		},

		[API.ListOffsets.key]: (d, _v, reply) => {
			d.readInt32(); // replica id
			const topics = d.readArray((t) => {
				const topic = t.readString() as string;
				const parts = t.readArray((p) => {
					const partition = p.readInt32();
					const timestamp = p.readInt64();
					p.readInt32(); // max number of offsets
					// -2 means earliest. Anything else is treated as latest.
					const offset = timestamp === -2n ? 0 : log(topic).length;
					return enc()
						.writeInt32(partition)
						.writeInt16(partition === 0 ? ERR.NONE : ERR.UNKNOWN_TOPIC_OR_PARTITION)
						.writeArray([enc().writeInt64(offset)]);
				});
				return enc().writeString(topic).writeArray(parts);
			});
			reply(enc().writeArray(topics));
		},

		[API.Fetch.key]: (d, _v, reply) => {
			d.readInt32(); // replica id
			const maxWait = d.readInt32();
			d.readInt32(); // min bytes
			d.readInt32(); // max bytes
			d.readInt8(); // isolation level
			const wanted = d.readArray((t) => ({
				topic: t.readString() as string,
				partitions: t.readArray((p) => {
					const partition = p.readInt32();
					const offset = Number(p.readInt64());
					p.readInt32(); // partition max bytes
					return { partition, offset };
				}),
			}));
			const hasData = () =>
				wanted.some(({ topic, partitions }) =>
					partitions.some((p) => p.partition === 0 && p.offset < log(topic).length),
				);

			const respond = async () => {
				const topics: Encoder[] = [];
				for (const { topic, partitions } of wanted) {
					const parts: Encoder[] = [];
					for (const { partition, offset } of partitions) {
						const records = log(topic);
						const hw = records.length;
						let error = ERR.NONE;
						if (partition !== 0) error = ERR.UNKNOWN_TOPIC_OR_PARTITION;
						else if (offset > hw || offset < 0) error = ERR.OFFSET_OUT_OF_RANGE;
						const batch = error === ERR.NONE && offset < hw ? records.slice(offset) : [];
						let recordSet: Buffer | null = null;
						if (batch.length > 0) {
							const first = batch[0].timestamp;
							const encoded = await RecordBatch({
								firstOffset: Long.fromValue(offset),
								firstTimestamp: first,
								maxTimestamp: batch[batch.length - 1].timestamp,
								lastOffsetDelta: batch.length - 1,
								records: batch.map((r, i) =>
									Record({
										offsetDelta: i,
										timestampDelta: r.timestamp - first,
										key: r.key,
										value: r.value,
										headers: r.headers,
									}),
								),
							});
							recordSet = encoded.buffer;
						}
						parts.push(
							enc()
								.writeInt32(partition)
								.writeInt16(error)
								.writeInt64(hw) // high watermark
								.writeInt64(hw) // last stable offset
								.writeArray([]) // aborted transactions
								.writeBytes(recordSet ?? Buffer.alloc(0)),
						);
					}
					topics.push(enc().writeString(topic).writeArray(parts));
				}
				reply(enc().writeInt32(0).writeArray(topics));
			};

			if (hasData()) return respond();
			// Long poll: wait for a record on one of the topics, or until maxWait passes.
			const topicNames = new Set(wanted.map((w) => w.topic));
			const wake = (topic: string | null) => {
				if (topic !== null && !topicNames.has(topic)) return;
				fetchWaiters.delete(wake);
				clearTimeout(timer);
				void respond();
			};
			const timer = setTimeout(() => wake(null), maxWait);
			fetchWaiters.add(wake);
		},

		[API.FindCoordinator.key]: (d, _v, reply) => {
			d.readString(); // group id
			reply(enc().writeInt16(ERR.NONE).writeInt32(0).writeString('127.0.0.1').writeInt32(port));
		},

		[API.JoinGroup.key]: (d, _v, reply) => {
			const g = group(d.readString() as string);
			const sessionTimeout = d.readInt32();
			let memberId = d.readString() || '';
			d.readString(); // protocol type
			const protocols = d.readArray((p) => ({
				name: p.readString() as string,
				metadata: p.readBytes(),
			}));
			if (memberId && !g.members.has(memberId)) {
				reply(joinError(ERR.UNKNOWN_MEMBER_ID, memberId));
				return;
			}
			if (!memberId) memberId = `member-${nextMemberId++}`;
			expireMembers(g);
			// We use the first protocol (assigner) the client offers.
			g.protocol = protocols[0]?.name ?? '';
			g.members.set(memberId, {
				metadata: protocols[0]?.metadata ?? Buffer.alloc(0),
				sessionTimeout,
				lastSeen: Date.now(),
			});
			g.rebalancing = true;
			g.pendingJoins.set(memberId, () => {
				const isLeader = g.leader === memberId;
				const members = isLeader
					? [...g.members].map(([id, m]) => enc().writeString(id).writeBytes(m.metadata))
					: [];
				reply(
					enc()
						.writeInt16(ERR.NONE)
						.writeInt32(g.generation)
						.writeString(g.protocol)
						.writeString(g.leader)
						.writeString(memberId)
						.writeArray(members),
				);
			});
			// Other members get REBALANCE_IN_PROGRESS on their next heartbeat and rejoin.
			// Members that never come back are dropped after the session timeout.
			if (g.pendingJoins.size === 1) {
				clearTimeout(g.joinTimer);
				g.joinTimer = setTimeout(() => completeJoin(g, true), sessionTimeout);
			}
			completeJoin(g);
		},

		[API.SyncGroup.key]: (d, _v, reply) => {
			const g = group(d.readString() as string);
			const generation = d.readInt32();
			const memberId = d.readString() as string;
			const assignments = d.readArray((a) => ({
				id: a.readString() as string,
				data: a.readBytes(),
			}));
			const member = g.members.get(memberId);
			if (!member)
				return reply(enc().writeInt16(ERR.UNKNOWN_MEMBER_ID).writeBytes(Buffer.alloc(0)));
			if (generation !== g.generation || g.rebalancing) {
				return reply(enc().writeInt16(ERR.REBALANCE_IN_PROGRESS).writeBytes(Buffer.alloc(0)));
			}
			member.lastSeen = Date.now();
			const respond = () =>
				reply(
					enc()
						.writeInt16(ERR.NONE)
						.writeBytes(g.assignments.get(memberId) ?? Buffer.alloc(0)),
				);
			// The leader sends everyone's assignment. We store it and echo each member's part.
			if (memberId === g.leader) {
				for (const a of assignments) g.assignments.set(a.id, a.data);
				respond();
				for (const wake of g.pendingSyncs.splice(0)) wake();
			} else if (g.assignments.size > 0) {
				respond();
			} else {
				g.pendingSyncs.push(respond);
			}
		},

		[API.Heartbeat.key]: (d, _v, reply) => {
			const g = group(d.readString() as string);
			const generation = d.readInt32();
			const member = g.members.get(d.readString() as string);
			expireMembers(g);
			let error = ERR.NONE;
			if (!member) error = ERR.UNKNOWN_MEMBER_ID;
			else if (g.rebalancing) error = ERR.REBALANCE_IN_PROGRESS;
			else if (generation !== g.generation) error = ERR.ILLEGAL_GENERATION;
			if (member) member.lastSeen = Date.now();
			reply(enc().writeInt16(error));
		},

		[API.LeaveGroup.key]: (d, _v, reply) => {
			const g = group(d.readString() as string);
			const memberId = d.readString() as string;
			g.members.delete(memberId);
			g.pendingJoins.delete(memberId);
			// The remaining members must rejoin to take over the partitions.
			if (g.members.size > 0) g.rebalancing = true;
			reply(enc().writeInt16(ERR.NONE));
			completeJoin(g);
		},

		[API.OffsetCommit.key]: (d, _v, reply) => {
			const g = group(d.readString() as string);
			d.readInt32(); // generation
			const member = g.members.get(d.readString() as string);
			if (member) member.lastSeen = Date.now();
			d.readInt64(); // retention time
			const topics = d.readArray((t) => {
				const topic = t.readString() as string;
				const parts = t.readArray((p) => {
					const partition = p.readInt32();
					const offset = p.readInt64();
					p.readString(); // metadata
					if (partition === 0) g.offsets.set(topic, offset);
					return enc().writeInt32(partition).writeInt16(ERR.NONE);
				});
				return enc().writeString(topic).writeArray(parts);
			});
			reply(enc().writeArray(topics));
		},

		[API.OffsetFetch.key]: (d, _v, reply) => {
			const g = group(d.readString() as string);
			const topics = d.readArray((t) => {
				const topic = t.readString() as string;
				const parts = t.readArray((p) => {
					const partition = p.readInt32();
					const offset = partition === 0 ? (g.offsets.get(topic) ?? -1n) : -1n;
					return enc()
						.writeInt32(partition)
						.writeInt64(offset)
						.writeString('')
						.writeInt16(ERR.NONE);
				});
				return enc().writeString(topic).writeArray(parts);
			});
			reply(enc().writeArray(topics));
		},
	};

	const joinError = (error: number, memberId: string) =>
		enc()
			.writeInt16(error)
			.writeInt32(-1)
			.writeString('')
			.writeString('')
			.writeString(memberId)
			.writeArray([]);

	// Splits the byte stream into size-prefixed requests and dispatches them.
	const onConnection = (socket: Socket) => {
		sockets.add(socket);
		let pending = Buffer.alloc(0);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => socket.destroy());
		socket.on('data', (chunk) => {
			pending = Buffer.concat([pending, chunk]);
			while (pending.length >= 4 && pending.length >= 4 + pending.readInt32BE(0)) {
				const size = pending.readInt32BE(0);
				const frame = pending.subarray(4, 4 + size);
				pending = pending.subarray(4 + size);
				const d = new DecoderClass(frame);
				const apiKey = d.readInt16();
				const version = d.readInt16();
				const correlationId = d.readInt32();
				d.readString(); // client id
				const handler = handlers[apiKey];
				if (!handler) {
					console.error(
						`[fake-kafka] unsupported api key ${apiKey} (version ${version}), closing socket`,
					);
					socket.destroy();
					return;
				}
				const reply: Reply = (body) => {
					if (socket.destroyed) return;
					const payload = enc().writeInt32(correlationId).writeEncoder(body);
					socket.write(enc().writeInt32(payload.size()).writeEncoder(payload).buffer);
				};
				Promise.resolve(handler(d, version, reply)).catch((error: unknown) => {
					console.error(
						`[fake-kafka] failed to handle api key ${apiKey} (version ${version})`,
						error,
					);
					socket.destroy();
				});
			}
		});
	};

	const server = createServer(onConnection);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as AddressInfo).port;

	return {
		port,
		produced,
		produce(topic, value, key, headers = {}) {
			append(topic, {
				key: key === undefined ? null : Buffer.from(key),
				value: Buffer.from(value),
				headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)])),
				timestamp: Date.now(),
			});
		},
		committed: (groupId, topic) => groups.get(groupId)?.offsets.get(topic),
		groupMembers: (groupId) => groups.get(groupId)?.members.size ?? 0,
		async close() {
			fetchWaiters.clear();
			for (const g of groups.values()) clearTimeout(g.joinTimer);
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
