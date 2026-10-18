// A fake PostgreSQL server for tests. It speaks just enough of the wire
// protocol (v3) for pg / pg-promise to connect, LISTEN and get notifications.
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

export interface FakePgServer {
	port: number;
	/** Sends NotificationResponse to every connection that listens on the channel. */
	notify(channel: string, payload: string): void;
	/** Channels that at least one connection listens on. */
	listening(): string[];
	/** Every query text the server got (simple and extended protocol). */
	queries: string[];
	/** Users from startup messages, in order. */
	users: string[];
	close(): Promise<void>;
}

interface Conn {
	socket: Socket;
	pid: number;
	buffer: Buffer;
	started: boolean;
	channels: Set<string>;
	/** Query text of the last Parse message, for the extended protocol. */
	parsed: string;
	/** True after an error in the extended protocol, until Sync. */
	skipUntilSync: boolean;
}

const SSL_REQUEST = 80877103;
const GSS_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

function message(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
	const head = Buffer.alloc(5);
	head.write(type, 0, 'ascii');
	head.writeInt32BE(body.length + 4, 1);
	return Buffer.concat([head, body]);
}

const cstr = (s: string) => Buffer.from(`${s}\0`, 'utf8');
const int16 = (n: number) => {
	const b = Buffer.alloc(2);
	b.writeInt16BE(n);
	return b;
};
const int32 = (n: number) => {
	const b = Buffer.alloc(4);
	b.writeInt32BE(n);
	return b;
};

/** Reads an SQL identifier: "Quoted" keeps case, plain names go lower case. */
function parseIdentifier(raw: string): string {
	const s = raw.trim().replace(/;$/, '').trim();
	if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/""/g, '"');
	return s.toLowerCase();
}

/** Builds the CommandComplete tag that Postgres would send for a query. */
function commandTag(sql: string, rows: number): string {
	const words = sql
		.trim()
		.replace(/;$/, '')
		.split(/\s+/)
		.map((w) => w.toUpperCase());
	const first = words[0] ?? '';
	switch (first) {
		case 'SELECT':
			return `SELECT ${rows}`;
		case 'INSERT':
			return 'INSERT 0 0';
		case 'UPDATE':
		case 'DELETE':
		case 'MOVE':
		case 'FETCH':
		case 'COPY':
			return `${first} 0`;
		case 'CREATE':
		case 'DROP':
		case 'ALTER': {
			// "CREATE OR REPLACE FUNCTION" reports "CREATE FUNCTION".
			const rest = words.slice(1).filter((w) => w !== 'OR' && w !== 'REPLACE');
			return `${first} ${rest[0] ?? ''}`.trim();
		}
		case 'START':
			return 'START TRANSACTION';
		default:
			return first;
	}
}

/** RowDescription for `SELECT 1`: one int4 column named "?column?". */
function selectOneRowDescription(): Buffer {
	const field = Buffer.concat([
		cstr('?column?'),
		int32(0),
		int16(0),
		int32(23),
		int16(4),
		int32(-1),
		int16(0),
	]);
	return message('T', Buffer.concat([int16(1), field]));
}

const isSelectOne = (sql: string) => /^\s*select\s+1\s*;?\s*$/i.test(sql);

export async function startPgServer(): Promise<FakePgServer> {
	const conns = new Set<Conn>();
	const queries: string[] = [];
	const users: string[] = [];
	let nextPid = 1000;

	const write = (conn: Conn, ...bufs: Buffer[]) => {
		if (!conn.socket.destroyed) conn.socket.write(Buffer.concat(bufs));
	};
	const ready = (conn: Conn) => write(conn, message('Z', Buffer.from('I')));

	// Applies LISTEN / UNLISTEN side effects of a query.
	const track = (conn: Conn, sql: string) => {
		const m = /^\s*(UNLISTEN|LISTEN)\s+(.+?)\s*;?\s*$/is.exec(sql);
		if (!m) return;
		const target = m[2].trim();
		if (m[1].toUpperCase() === 'LISTEN') conn.channels.add(parseIdentifier(target));
		else if (target === '*') conn.channels.clear();
		else conn.channels.delete(parseIdentifier(target));
	};

	// Writes the result messages for one statement (no ReadyForQuery).
	const result = (conn: Conn, sql: string, withRowDescription: boolean) => {
		if (sql.trim() === '') {
			write(conn, message('I'));
			return;
		}
		track(conn, sql);
		if (isSelectOne(sql)) {
			const out: Buffer[] = [];
			if (withRowDescription) {
				out.push(selectOneRowDescription());
			}
			out.push(message('D', Buffer.concat([int16(1), int32(1), Buffer.from('1')])));
			out.push(message('C', cstr('SELECT 1')));
			write(conn, ...out);
			return;
		}
		write(conn, message('C', cstr(commandTag(sql, 0))));
	};

	const onStartup = (conn: Conn, body: Buffer) => {
		const code = body.readInt32BE(0);
		if (code === SSL_REQUEST || code === GSS_REQUEST) {
			write(conn, Buffer.from('N'));
			return;
		}
		if (code === CANCEL_REQUEST) {
			conn.socket.end();
			return;
		}
		// Protocol 3.0: key/value pairs of C strings.
		const parts = body.subarray(4).toString('utf8').split('\0');
		const params: Record<string, string> = {};
		for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) params[parts[i]] = parts[i + 1];
		users.push(params.user ?? '');
		conn.started = true;
		const status = (k: string, v: string) => message('S', Buffer.concat([cstr(k), cstr(v)]));
		write(
			conn,
			message('R', int32(0)),
			status('server_version', '16.0'),
			status('server_encoding', 'UTF8'),
			status('client_encoding', 'UTF8'),
			status('DateStyle', 'ISO, MDY'),
			status('integer_datetimes', 'on'),
			status('TimeZone', 'UTC'),
			status('standard_conforming_strings', 'on'),
			status('application_name', params.application_name ?? ''),
			message('K', Buffer.concat([int32(conn.pid), int32(12345)])),
		);
		ready(conn);
	};

	const onMessage = (conn: Conn, type: string, body: Buffer) => {
		if (conn.skipUntilSync && type !== 'S') return;
		switch (type) {
			case 'Q': {
				const sql = body.toString('utf8').replace(/\0$/, '');
				queries.push(sql);
				result(conn, sql, true);
				ready(conn);
				return;
			}
			case 'P': {
				// Parse: statement name, query text, parameter types.
				const end = body.indexOf(0);
				const sqlEnd = body.indexOf(0, end + 1);
				conn.parsed = body.subarray(end + 1, sqlEnd).toString('utf8');
				queries.push(conn.parsed);
				write(conn, message('1'));
				return;
			}
			case 'B':
				write(conn, message('2'));
				return;
			case 'D':
				if (body[0] === 0x53 /* 'S' statement */) write(conn, message('t', int16(0)));
				if (isSelectOne(conn.parsed)) {
					write(conn, selectOneRowDescription());
				} else {
					write(conn, message('n'));
				}
				return;
			case 'E':
				result(conn, conn.parsed, false);
				return;
			case 'C':
				write(conn, message('3'));
				return;
			case 'S':
				conn.skipUntilSync = false;
				ready(conn);
				return;
			case 'H':
				return;
			case 'X':
				conn.socket.end();
				return;
			default:
				write(
					conn,
					message(
						'E',
						Buffer.concat([
							cstr('SERROR'),
							cstr('C0A000'),
							cstr(`Mfake server does not support message '${type}'`),
							Buffer.from([0]),
						]),
					),
				);
				conn.skipUntilSync = true;
				return;
		}
	};

	const onData = (conn: Conn, data: Buffer) => {
		conn.buffer = conn.buffer.length ? Buffer.concat([conn.buffer, data]) : data;
		for (;;) {
			if (!conn.started) {
				// Startup messages have no type byte.
				if (conn.buffer.length < 8) return;
				const len = conn.buffer.readInt32BE(0);
				if (conn.buffer.length < len) return;
				const body = conn.buffer.subarray(4, len);
				conn.buffer = conn.buffer.subarray(len);
				onStartup(conn, body);
				if (conn.socket.destroyed) return;
				continue;
			}
			if (conn.buffer.length < 5) return;
			const len = conn.buffer.readInt32BE(1);
			if (conn.buffer.length < len + 1) return;
			const type = String.fromCharCode(conn.buffer[0]);
			const body = conn.buffer.subarray(5, len + 1);
			conn.buffer = conn.buffer.subarray(len + 1);
			onMessage(conn, type, body);
		}
	};

	const server = createServer((socket) => {
		const conn: Conn = {
			socket,
			pid: nextPid++,
			buffer: Buffer.alloc(0),
			started: false,
			channels: new Set(),
			parsed: '',
			skipUntilSync: false,
		};
		conns.add(conn);
		socket.on('data', (data) => onData(conn, data));
		socket.on('error', () => {});
		socket.on('close', () => conns.delete(conn));
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});

	return {
		port: (server.address() as AddressInfo).port,
		queries,
		users,
		notify(channel, payload) {
			for (const conn of conns) {
				if (!conn.channels.has(channel)) continue;
				write(conn, message('A', Buffer.concat([int32(1), cstr(channel), cstr(payload)])));
			}
		},
		listening() {
			const all = new Set<string>();
			for (const conn of conns) for (const c of conn.channels) all.add(c);
			return [...all];
		},
		async close() {
			for (const conn of conns) conn.socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
