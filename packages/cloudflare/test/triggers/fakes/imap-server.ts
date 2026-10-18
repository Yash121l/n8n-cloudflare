// A tiny in-process IMAP4rev1 server for tests. Plain TCP, one INBOX, user "user" / "pass".
// It covers what imapflow (as used by @n8n/imap and the Email Trigger node) sends.
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

export interface FakeImapServer {
	port: number;
	/** Adds a message to INBOX with the next UID and announces it to clients in IDLE (or on next NOOP) with an untagged EXISTS. `raw` is an RFC 822 message with CRLF line ends. */
	addMessage(raw: string, flags?: string[]): number; // returns the UID
	/** Flags of a message by UID. */
	flags(uid: number): string[];
	/** Commands received, as raw lines without the tag, for debugging assertions. */
	commands: string[];
	/** Number of connections that are logged in and have a mailbox selected. */
	selectedClients(): number;
	close(): Promise<void>;
}

const USER = 'user';
const PASS = 'pass';
const UID_VALIDITY = 1;
const CAPABILITIES = 'IMAP4rev1 LITERAL+ IDLE NAMESPACE UIDPLUS ENABLE ID AUTH=PLAIN';
const SYSTEM_FLAGS = ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// All text is kept as latin1 strings, so string length equals byte length.
interface Message {
	uid: number;
	raw: string;
	flags: Set<string>;
	internalDate: Date;
	mime: MimeNode;
}

interface MimeNode {
	header: string; // includes the blank line that ends it
	body: string;
	type: string;
	subtype: string;
	params: Record<string, string>;
	children?: MimeNode[];
}

interface Conn {
	socket: Socket;
	authed: boolean;
	selected: boolean;
	readOnly: boolean;
	known: number; // EXISTS count this client has been told
	idleTag?: string;
	authTag?: string; // waiting for AUTHENTICATE PLAIN data
	buf: string;
	line: string;
	literals: string[];
	literalLeft: number;
}

type Token = { t: 'atom'; v: string } | { t: 'str'; v: string } | { t: 'list'; v: Token[] };

/** A simple text/plain message with Date and Message-ID headers. */
export function rfc822(
	subject: string,
	text: string,
	from = 'sender@example.com',
	to = 'user@example.com',
): string {
	const body = text.replace(/\r?\n/g, '\r\n');
	const eightBit = /[^\x00-\x7f]/.test(subject + body);
	return [
		`Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@fake-imap.test>`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		`Content-Transfer-Encoding: ${eightBit ? '8bit' : '7bit'}`,
		'',
		body,
	].join('\r\n');
}

export async function startImapServer(): Promise<FakeImapServer> {
	const messages: Message[] = [];
	const conns = new Set<Conn>();
	const commands: string[] = [];
	let nextUid = 1;

	const write = (c: Conn, data: string) => {
		if (!c.socket.destroyed) c.socket.write(Buffer.from(data, 'latin1'));
	};

	// Tell the client about new messages before a tagged reply.
	const flushExists = (c: Conn) => {
		if (c.selected && c.known !== messages.length) {
			c.known = messages.length;
			write(c, `* ${messages.length} EXISTS\r\n`);
		}
	};

	const ok = (c: Conn, tag: string, text: string) => {
		flushExists(c);
		write(c, `${tag} OK ${text}\r\n`);
	};
	const no = (c: Conn, tag: string, text: string) => write(c, `${tag} NO ${text}\r\n`);
	const bad = (c: Conn, tag: string, text: string) => write(c, `${tag} BAD ${text}\r\n`);

	const handle = (c: Conn, fullLine: string) => {
		const literals = c.literals;
		c.literals = [];

		if (c.idleTag !== undefined) {
			commands.push(fullLine);
			const tag = c.idleTag;
			c.idleTag = undefined;
			if (fullLine.trim().toUpperCase() === 'DONE') ok(c, tag, 'IDLE terminated');
			else bad(c, tag, 'Expected DONE');
			return;
		}

		if (c.authTag !== undefined) {
			const tag = c.authTag;
			c.authTag = undefined;
			finishPlain(c, tag, fullLine.trim());
			return;
		}

		const space = fullLine.indexOf(' ');
		if (space <= 0) {
			write(c, `* BAD Missing tag\r\n`);
			return;
		}
		const tag = fullLine.slice(0, space);
		const rest = fullLine.slice(space + 1);
		commands.push(
			rest.replace(/\0(\d+)\0/g, (_m, i: string) => JSON.stringify(literals[Number(i)])),
		);

		let args: Token[];
		try {
			args = tokenize(rest, literals);
		} catch {
			bad(c, tag, 'Parse error');
			return;
		}
		let name = atom(args.shift()).toUpperCase();
		let uid = false;
		if (name === 'UID') {
			uid = true;
			name = atom(args.shift()).toUpperCase();
		}

		try {
			run(c, tag, name, args, uid);
		} catch (error) {
			bad(c, tag, (error as Error).message || 'Error');
		}
	};

	const finishPlain = (c: Conn, tag: string, data: string) => {
		if (data === '*') return bad(c, tag, 'Authentication cancelled');
		const parts = Buffer.from(data, 'base64').toString('utf8').split('\0');
		const [, user, pass] = parts.length === 3 ? parts : ['', '', ''];
		if (user === USER && pass === PASS) {
			c.authed = true;
			ok(c, tag, `[CAPABILITY ${CAPABILITIES}] Authenticated`);
		} else {
			no(c, tag, '[AUTHENTICATIONFAILED] Invalid credentials');
		}
	};

	const needAuth = (c: Conn) => {
		if (!c.authed) throw new Error('Not authenticated');
	};
	const needSelected = (c: Conn) => {
		needAuth(c);
		if (!c.selected) throw new Error('No mailbox selected');
	};

	const run = (c: Conn, tag: string, name: string, args: Token[], uid: boolean) => {
		switch (name) {
			case 'CAPABILITY':
				write(c, `* CAPABILITY ${CAPABILITIES}\r\n`);
				return ok(c, tag, 'CAPABILITY completed');
			case 'NOOP':
			case 'CHECK':
				return ok(c, tag, `${name} completed`);
			case 'ID':
				write(c, `* ID ("name" "fake-imap")\r\n`);
				return ok(c, tag, 'ID completed');
			case 'LOGOUT':
				write(c, `* BYE Logging out\r\n`);
				write(c, `${tag} OK LOGOUT completed\r\n`);
				c.socket.end();
				return;
			case 'LOGIN': {
				const user = text(args[0]);
				const pass = text(args[1]);
				if (user === USER && pass === PASS) {
					c.authed = true;
					return ok(c, tag, `[CAPABILITY ${CAPABILITIES}] Logged in`);
				}
				return no(c, tag, '[AUTHENTICATIONFAILED] Invalid credentials');
			}
			case 'AUTHENTICATE': {
				if (atom(args[0]).toUpperCase() !== 'PLAIN') return no(c, tag, 'Unsupported mechanism');
				if (args[1]) return finishPlain(c, tag, text(args[1]));
				c.authTag = tag;
				return write(c, '+ \r\n');
			}
			case 'ENABLE':
				needAuth(c);
				// Nothing we advertise needs enabling; report none.
				write(c, `* ENABLED\r\n`);
				return ok(c, tag, 'ENABLE completed');
			case 'NAMESPACE':
				needAuth(c);
				write(c, `* NAMESPACE (("" "/")) NIL NIL\r\n`);
				return ok(c, tag, 'NAMESPACE completed');
			case 'LIST':
			case 'LSUB': {
				needAuth(c);
				const pattern = text(args[1]);
				if (pattern === '') {
					write(c, `* ${name} (\\Noselect) "/" ""\r\n`);
				} else if (matchesPattern('INBOX', text(args[0]) + pattern)) {
					write(c, `* ${name} (\\HasNoChildren) "/" INBOX\r\n`);
				}
				return ok(c, tag, `${name} completed`);
			}
			case 'STATUS': {
				needAuth(c);
				if (!isInbox(text(args[0]))) return no(c, tag, 'No such mailbox');
				const items = list(args[1]).map((t) => atom(t).toUpperCase());
				const values: Record<string, number> = {
					MESSAGES: messages.length,
					UIDNEXT: nextUid,
					UIDVALIDITY: UID_VALIDITY,
					UNSEEN: messages.filter((m) => !m.flags.has('\\Seen')).length,
					RECENT: 0,
				};
				const out = items.filter((i) => i in values).map((i) => `${i} ${values[i]}`);
				write(c, `* STATUS INBOX (${out.join(' ')})\r\n`);
				return ok(c, tag, 'STATUS completed');
			}
			case 'SELECT':
			case 'EXAMINE': {
				needAuth(c);
				c.selected = false;
				if (!isInbox(text(args[0]))) return no(c, tag, 'No such mailbox');
				c.selected = true;
				c.readOnly = name === 'EXAMINE';
				c.known = messages.length;
				const unseen = messages.findIndex((m) => !m.flags.has('\\Seen'));
				write(c, `* FLAGS (${SYSTEM_FLAGS.join(' ')})\r\n`);
				write(c, `* OK [PERMANENTFLAGS (${SYSTEM_FLAGS.join(' ')} \\*)] Flags permitted\r\n`);
				write(c, `* ${messages.length} EXISTS\r\n`);
				write(c, `* 0 RECENT\r\n`);
				if (unseen >= 0) write(c, `* OK [UNSEEN ${unseen + 1}] First unseen\r\n`);
				write(c, `* OK [UIDVALIDITY ${UID_VALIDITY}] UIDs valid\r\n`);
				write(c, `* OK [UIDNEXT ${nextUid}] Predicted next UID\r\n`);
				return ok(c, tag, `[${c.readOnly ? 'READ-ONLY' : 'READ-WRITE'}] ${name} completed`);
			}
			case 'CLOSE':
			case 'UNSELECT':
				needSelected(c);
				c.selected = false;
				return write(c, `${tag} OK ${name} completed\r\n`);
			case 'EXPUNGE':
				needSelected(c);
				// Expunge is not supported; nothing is ever removed.
				return ok(c, tag, 'EXPUNGE completed');
			case 'IDLE':
				needAuth(c);
				c.idleTag = tag;
				write(c, '+ idling\r\n');
				flushExists(c);
				return;
			case 'SEARCH': {
				needSelected(c);
				if (atom(args[0]).toUpperCase() === 'CHARSET') args = args.slice(2);
				const found = messages.filter((m, i) => matchAll(args, m, i + 1));
				const ids = found.map((m) => (uid ? m.uid : messages.indexOf(m) + 1));
				write(c, `* SEARCH${ids.map((n) => ` ${n}`).join('')}\r\n`);
				return ok(c, tag, `${uid ? 'UID ' : ''}SEARCH completed`);
			}
			case 'FETCH': {
				needSelected(c);
				const picked = pick(atom(args[0]), uid);
				const items = args[1].t === 'list' ? args[1].v.map(atom) : [atom(args[1])];
				for (const seq of picked) fetchOne(c, seq, items, uid);
				return ok(c, tag, `${uid ? 'UID ' : ''}FETCH completed`);
			}
			case 'STORE': {
				needSelected(c);
				if (c.readOnly) return no(c, tag, 'Mailbox is read-only');
				const picked = pick(atom(args[0]), uid);
				let op = atom(args[1]).toUpperCase();
				// Skip modifiers such as (UNCHANGEDSINCE n).
				let at = 2;
				if (args[1].t === 'list') {
					op = atom(args[2]).toUpperCase();
					at = 3;
				}
				const silent = op.endsWith('.SILENT');
				const mode = op.replace('.SILENT', '');
				const flagArg = args[at];
				const given = (flagArg?.t === 'list' ? flagArg.v : args.slice(at)).map((t) =>
					normalizeFlag(atom(t)),
				);
				for (const seq of picked) {
					const m = messages[seq - 1];
					if (mode === 'FLAGS') m.flags = new Set(given);
					else if (mode === '+FLAGS') given.forEach((f) => m.flags.add(f));
					else if (mode === '-FLAGS') given.forEach((f) => m.flags.delete(f));
					else return bad(c, tag, 'Unknown STORE operation');
					if (!silent)
						write(c, `* ${seq} FETCH (UID ${m.uid} FLAGS (${[...m.flags].join(' ')}))\r\n`);
				}
				return ok(c, tag, `${uid ? 'UID ' : ''}STORE completed`);
			}
			default:
				return bad(c, tag, `Unknown command ${name}`);
		}
	};

	/** Sequence numbers for a sequence set (or UID set). */
	const pick = (set: string, uid: boolean): number[] => {
		if (messages.length === 0) return [];
		const values = messages.map((m, i) => (uid ? m.uid : i + 1));
		const max = values[values.length - 1];
		const out: number[] = [];
		messages.forEach((_m, i) => {
			if (inSet(set, values[i], max)) out.push(i + 1);
		});
		return out;
	};

	const fetchOne = (c: Conn, seq: number, rawItems: string[], uid: boolean) => {
		const m = messages[seq - 1];
		let items = rawItems.flatMap((item) => {
			const up = item.toUpperCase();
			if (up === 'ALL') return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'];
			if (up === 'FAST') return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'];
			if (up === 'FULL') return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY'];
			return [item];
		});
		if (uid && !items.some((i) => i.toUpperCase() === 'UID')) items = ['UID', ...items];

		const parts: string[] = [];
		let markSeen = false;
		for (const item of items) {
			const up = item.toUpperCase();
			if (up === 'UID') parts.push(`UID ${m.uid}`);
			else if (up === 'FLAGS') parts.push(`FLAGS (${[...m.flags].join(' ')})`);
			else if (up === 'INTERNALDATE') parts.push(`INTERNALDATE "${imapDateTime(m.internalDate)}"`);
			else if (up === 'RFC822.SIZE') parts.push(`RFC822.SIZE ${m.raw.length}`);
			else if (up === 'ENVELOPE') parts.push(`ENVELOPE ${envelope(m.mime.header)}`);
			else if (up === 'BODYSTRUCTURE') parts.push(`BODYSTRUCTURE ${bodyStructure(m.mime, true)}`);
			else if (up === 'BODY') parts.push(`BODY ${bodyStructure(m.mime, false)}`);
			else if (up === 'RFC822') {
				parts.push(`RFC822 ${literal(m.raw)}`);
				markSeen = true;
			} else if (up === 'RFC822.HEADER') parts.push(`RFC822.HEADER ${literal(m.mime.header)}`);
			else if (up === 'RFC822.TEXT') {
				parts.push(`RFC822.TEXT ${literal(m.mime.body)}`);
				markSeen = true;
			} else if (up === 'MODSEQ') parts.push('MODSEQ (1)');
			else {
				const match = /^BODY(\.PEEK)?\[(.*)\](?:<(\d+)(?:\.(\d+))?>)?$/is.exec(item);
				if (!match) throw new Error(`Unknown FETCH item ${item}`);
				const [, peek, section, start, length] = match;
				let data = sectionData(m, section);
				let name = `BODY[${section.toUpperCase()}]`;
				if (start !== undefined) {
					const from = Number(start);
					data = length === undefined ? data.slice(from) : data.slice(from, from + Number(length));
					name += `<${from}>`;
				}
				parts.push(`${name} ${literal(data)}`);
				if (!peek) markSeen = true;
			}
		}
		if (markSeen && !c.readOnly && !m.flags.has('\\Seen')) {
			m.flags.add('\\Seen');
			if (!items.some((i) => i.toUpperCase() === 'FLAGS'))
				parts.push(`FLAGS (${[...m.flags].join(' ')})`);
		}
		write(c, `* ${seq} FETCH (${parts.join(' ')})\r\n`);
	};

	const matchAll = (keys: Token[], m: Message, seq: number): boolean => {
		const queue = [...keys];
		while (queue.length) {
			if (!matchOne(queue, m, seq)) return false;
		}
		return true;
	};

	// Consumes one search key (with its arguments) from the queue.
	const matchOne = (queue: Token[], m: Message, seq: number): boolean => {
		const token = queue.shift() as Token;
		if (token.t === 'list') return matchAll(token.v, m, seq);
		const key = token.v.toUpperCase();
		const arg = () => text(queue.shift());
		const has = (flag: string) => m.flags.has(flag);
		const header = (name: string) => headerValues(m.mime.header, name).join('\n');
		const contains = (hay: string, needle: string) =>
			decode(hay).toLowerCase().includes(decode(needle).toLowerCase());
		switch (key) {
			case 'ALL':
				return true;
			case 'ANSWERED':
			case 'DELETED':
			case 'DRAFT':
			case 'FLAGGED':
			case 'SEEN':
				return has(normalizeFlag(`\\${key}`));
			case 'UNANSWERED':
			case 'UNDELETED':
			case 'UNDRAFT':
			case 'UNFLAGGED':
			case 'UNSEEN':
				return !has(normalizeFlag(`\\${key.slice(2)}`));
			case 'NEW':
				return !has('\\Seen');
			case 'OLD':
				return true;
			case 'RECENT':
				return false;
			case 'KEYWORD':
				return has(arg());
			case 'UNKEYWORD':
				return !has(arg());
			case 'BEFORE':
				return dayOf(m.internalDate) < parseImapDate(arg());
			case 'ON':
				return dayOf(m.internalDate) === parseImapDate(arg());
			case 'SINCE':
				return dayOf(m.internalDate) >= parseImapDate(arg());
			case 'SENTBEFORE':
				return dayOf(sentDate(m)) < parseImapDate(arg());
			case 'SENTON':
				return dayOf(sentDate(m)) === parseImapDate(arg());
			case 'SENTSINCE':
				return dayOf(sentDate(m)) >= parseImapDate(arg());
			case 'SUBJECT':
			case 'FROM':
			case 'TO':
			case 'CC':
			case 'BCC':
				return contains(header(key), arg());
			case 'HEADER': {
				const name = arg();
				const value = arg();
				const values = headerValues(m.mime.header, name);
				return values.length > 0 && (value === '' || contains(values.join('\n'), value));
			}
			case 'BODY':
				return contains(m.mime.body, arg());
			case 'TEXT':
				return contains(m.raw, arg());
			case 'LARGER':
				return m.raw.length > Number(arg());
			case 'SMALLER':
				return m.raw.length < Number(arg());
			case 'UID': {
				const set = arg();
				return inSet(set, m.uid, messages[messages.length - 1].uid);
			}
			case 'MODSEQ':
				arg();
				return true;
			case 'NOT':
				return !matchOne(queue, m, seq);
			case 'OR': {
				const left = matchOne(queue, m, seq);
				const right = matchOne(queue, m, seq);
				return left || right;
			}
			default:
				if (/^[\d*:,]+$/.test(key)) return inSet(key, seq, messages.length);
				throw new Error(`Unknown search key ${key}`);
		}
	};

	const onData = (c: Conn, chunk: Buffer) => {
		c.buf += chunk.toString('latin1');
		while (c.buf.length) {
			if (c.literalLeft > 0) {
				if (c.buf.length < c.literalLeft) return;
				c.literals.push(c.buf.slice(0, c.literalLeft));
				c.line += `\0${c.literals.length - 1}\0`;
				c.buf = c.buf.slice(c.literalLeft);
				c.literalLeft = 0;
				continue;
			}
			const end = c.buf.indexOf('\r\n');
			if (end < 0) return;
			const segment = c.buf.slice(0, end);
			c.buf = c.buf.slice(end + 2);
			const lit = /\{(\d+)(\+)?\}$/.exec(segment);
			if (lit) {
				c.line += segment.slice(0, lit.index);
				c.literalLeft = Number(lit[1]);
				if (!lit[2]) write(c, '+ Ready\r\n');
				if (c.literalLeft === 0) {
					c.literals.push('');
					c.line += `\0${c.literals.length - 1}\0`;
				}
				continue;
			}
			const line = c.line + segment;
			c.line = '';
			handle(c, line);
		}
	};

	const server = createServer((socket) => {
		const c: Conn = {
			socket,
			authed: false,
			selected: false,
			readOnly: false,
			known: 0,
			buf: '',
			line: '',
			literals: [],
			literalLeft: 0,
		};
		conns.add(c);
		socket.on('data', (chunk: Buffer) => onData(c, chunk));
		socket.on('error', () => {});
		socket.on('close', () => conns.delete(c));
		write(c, `* OK [CAPABILITY ${CAPABILITIES}] Fake IMAP ready\r\n`);
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;

	return {
		port,
		commands,
		addMessage(raw: string, flags: string[] = []): number {
			const bytes = Buffer.from(raw, 'utf8').toString('latin1');
			const message: Message = {
				uid: nextUid++,
				raw: bytes,
				flags: new Set(flags.map(normalizeFlag)),
				internalDate: new Date(),
				mime: parseMime(bytes),
			};
			messages.push(message);
			// Tell selected clients now, in IDLE or not. imapflow waits 15 s before it starts
			// IDLE, so waiting for IDLE or the next command would make tests slow.
			for (const c of conns) flushExists(c);
			return message.uid;
		},
		flags(uid: number): string[] {
			const m = messages.find((x) => x.uid === uid);
			if (!m) throw new Error(`No message with UID ${uid}`);
			return [...m.flags];
		},
		selectedClients(): number {
			return [...conns].filter((c) => c.authed && c.selected && !c.socket.destroyed).length;
		},
		async close(): Promise<void> {
			for (const c of conns) c.socket.destroy();
			conns.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

// ---- parsing helpers ----

function tokenize(s: string, literals: string[]): Token[] {
	let i = 0;
	const parse = (): Token[] => {
		const out: Token[] = [];
		while (i < s.length) {
			const ch = s[i];
			if (ch === ' ') {
				i++;
			} else if (ch === ')') {
				i++;
				return out;
			} else if (ch === '(') {
				i++;
				out.push({ t: 'list', v: parse() });
			} else if (ch === '"') {
				i++;
				let v = '';
				while (i < s.length && s[i] !== '"') {
					if (s[i] === '\\') i++;
					v += s[i++];
				}
				i++;
				out.push({ t: 'str', v });
			} else if (ch === '\0') {
				const end = s.indexOf('\0', i + 1);
				out.push({ t: 'str', v: literals[Number(s.slice(i + 1, end))] });
				i = end + 1;
			} else {
				// An atom; brackets may hold spaces, as in BODY.PEEK[HEADER.FIELDS (A B)].
				let v = '';
				let depth = 0;
				while (i < s.length) {
					const c = s[i];
					if (depth === 0 && (c === ' ' || c === '(' || c === ')' || c === '"')) break;
					if (c === '[') depth++;
					if (c === ']') depth--;
					v += c;
					i++;
				}
				out.push({ t: 'atom', v });
			}
		}
		return out;
	};
	return parse();
}

function atom(t: Token | undefined): string {
	if (!t) throw new Error('Missing argument');
	if (t.t === 'list') throw new Error('Unexpected list');
	return t.v;
}

function text(t: Token | undefined): string {
	return atom(t);
}

function list(t: Token | undefined): Token[] {
	if (!t) return [];
	return t.t === 'list' ? t.v : [t];
}

function isInbox(name: string): boolean {
	return name.toUpperCase() === 'INBOX';
}

function matchesPattern(name: string, pattern: string): boolean {
	const re = new RegExp(
		`^${pattern
			.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
			.replace(/\*/g, '.*')
			.replace(/%/g, '[^/]*')}$`,
		'i',
	);
	return re.test(name);
}

/** Is `value` in an IMAP sequence set like "1,3:5,7:*"? `*` means `max`. */
function inSet(set: string, value: number, max: number): boolean {
	return set.split(',').some((range) => {
		const [a, b = a] = range.split(':').map((x) => (x === '*' ? max : Number(x)));
		return value >= Math.min(a, b) && value <= Math.max(a, b);
	});
}

function normalizeFlag(flag: string): string {
	const known = SYSTEM_FLAGS.find((f) => f.toLowerCase() === flag.toLowerCase());
	return known ?? flag;
}

// Dates as local day numbers (yyyymmdd), like a server in this time zone.
function dayOf(date: Date): number {
	return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

function parseImapDate(value: string): number {
	const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
	if (!m) throw new Error(`Bad date ${value}`);
	const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
	return Number(m[3]) * 10000 + (month + 1) * 100 + Number(m[1]);
}

function sentDate(m: Message): Date {
	const value = headerValues(m.mime.header, 'date')[0];
	const date = value ? new Date(value) : m.internalDate;
	return Number.isNaN(date.getTime()) ? m.internalDate : date;
}

function imapDateTime(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const offset = -d.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	const abs = Math.abs(offset);
	return `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

function decode(s: string): string {
	return Buffer.from(s, 'latin1').toString('utf8');
}

// ---- MIME helpers ----

function parseMime(raw: string): MimeNode {
	let header: string;
	let body: string;
	if (raw.startsWith('\r\n')) {
		header = '\r\n';
		body = raw.slice(2);
	} else {
		const end = raw.indexOf('\r\n\r\n');
		header = end < 0 ? `${raw}\r\n\r\n` : raw.slice(0, end + 4);
		body = end < 0 ? '' : raw.slice(end + 4);
	}
	const ct = parseParams(headerValues(header, 'content-type')[0] ?? 'text/plain; charset=us-ascii');
	const [type = 'text', subtype = 'plain'] = ct.value.toLowerCase().split('/');
	const node: MimeNode = { header, body, type, subtype, params: ct.params };
	if (type === 'multipart' && ct.params.boundary) {
		node.children = splitMultipart(body, ct.params.boundary).map(parseMime);
	}
	return node;
}

function splitMultipart(body: string, boundary: string): string[] {
	const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(`(^|\\r\\n)--${escaped}(--)?[ \\t]*(\\r\\n|$)`, 'g');
	const parts: string[] = [];
	let start = -1;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body))) {
		if (start >= 0) parts.push(body.slice(start, m.index));
		if (m[2]) break;
		start = m.index + m[0].length;
	}
	return parts;
}

/** Unfolded values of a header, in order. */
function headerValues(header: string, name: string): string[] {
	const unfolded = header.replace(/\r\n[ \t]+/g, ' ');
	const wanted = name.toLowerCase();
	const out: string[] = [];
	for (const line of unfolded.split('\r\n')) {
		const colon = line.indexOf(':');
		if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === wanted)
			out.push(line.slice(colon + 1).trim());
	}
	return out;
}

function parseParams(value: string): { value: string; params: Record<string, string> } {
	const [first, ...rest] = value.split(';');
	const params: Record<string, string> = {};
	for (const p of rest) {
		const eq = p.indexOf('=');
		if (eq < 0) continue;
		params[p.slice(0, eq).trim().toLowerCase()] = p
			.slice(eq + 1)
			.trim()
			.replace(/^"(.*)"$/, '$1');
	}
	return { value: first.trim(), params };
}

/** Header lines kept (or dropped, with `not`) by name, plus the closing blank line. */
function filterHeader(header: string, names: string[], not: boolean): string {
	const wanted = new Set(names.map((n) => n.toLowerCase()));
	const lines = header.replace(/\r\n\r\n$/, '').split(/\r\n(?![ \t])/);
	const kept = lines.filter((line) => {
		const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
		return wanted.has(name) !== not;
	});
	return kept.map((l) => `${l}\r\n`).join('') + '\r\n';
}

function sectionData(m: Message, section: string): string {
	const s = section.trim();
	const pathMatch = /^(\d+(?:\.\d+)*)(?:\.(.*))?$/s.exec(s);
	const path = pathMatch ? pathMatch[1].split('.').map(Number) : [];
	const rest = (pathMatch ? (pathMatch[2] ?? '') : s).trim();

	let node: MimeNode | undefined = m.mime;
	for (const n of path) {
		if (!node) break;
		if (node.children) node = node.children[n - 1];
		else if (n !== 1) node = undefined;
		// A single-part body is part 1 of itself.
	}
	if (!node) return '';

	const up = rest.toUpperCase();
	if (up === '') return path.length ? node.body : m.raw;
	if (up === 'HEADER' || up === 'MIME') return node.header;
	if (up === 'TEXT') return node.body;
	const fields = /^HEADER\.FIELDS(\.NOT)?\s*\((.*)\)$/is.exec(rest);
	if (fields) {
		const names = fields[2]
			.split(/\s+/)
			.filter(Boolean)
			.map((n) => n.replace(/^"(.*)"$/, '$1'));
		return filterHeader(node.header, names, !!fields[1]);
	}
	throw new Error(`Unknown section ${section}`);
}

// ---- response formatting ----

/** A quoted string, or a literal when the text needs one. */
function str(s: string | undefined): string {
	if (s === undefined) return 'NIL';
	if (/[\r\n\x00\x80-\xff"\\]/.test(s)) return literal(s);
	return `"${s}"`;
}

function literal(s: string): string {
	return `{${s.length}}\r\n${s}`;
}

function paramList(params: Record<string, string>): string {
	const entries = Object.entries(params);
	if (!entries.length) return 'NIL';
	return `(${entries.map(([k, v]) => `${str(k.toUpperCase())} ${str(v)}`).join(' ')})`;
}

function bodyStructure(node: MimeNode, extended: boolean): string {
	if (node.children) {
		const kids = node.children.map((child) => bodyStructure(child, extended)).join('');
		const ext = extended ? ` ${paramList(node.params)} NIL NIL NIL` : '';
		return `(${kids} ${str(node.subtype.toUpperCase())}${ext})`;
	}
	const h = (name: string) => headerValues(node.header, name)[0];
	const encoding = (h('content-transfer-encoding') ?? '7bit').toUpperCase();
	const fields = [
		str(node.type.toUpperCase()),
		str(node.subtype.toUpperCase()),
		paramList(node.params),
		str(h('content-id')),
		str(h('content-description')),
		str(encoding),
		String(node.body.length),
	];
	if (node.type === 'text') fields.push(String((node.body.match(/\r\n/g) ?? []).length));
	if (extended) {
		const dispValue = h('content-disposition');
		let disposition = 'NIL';
		if (dispValue) {
			const d = parseParams(dispValue);
			disposition = `(${str(d.value.toLowerCase())} ${paramList(d.params)})`;
		}
		fields.push('NIL', disposition, 'NIL', 'NIL');
	}
	return `(${fields.join(' ')})`;
}

function envelope(header: string): string {
	const h = (name: string) => headerValues(header, name)[0];
	const from = addresses(h('from'));
	const sender = addresses(h('sender')) ?? from;
	const replyTo = addresses(h('reply-to')) ?? from;
	return `(${[
		str(h('date')),
		str(h('subject')),
		from ?? 'NIL',
		sender ?? 'NIL',
		replyTo ?? 'NIL',
		addresses(h('to')) ?? 'NIL',
		addresses(h('cc')) ?? 'NIL',
		addresses(h('bcc')) ?? 'NIL',
		str(h('in-reply-to')),
		str(h('message-id')),
	].join(' ')})`;
}

function addresses(value: string | undefined): string | undefined {
	if (!value) return undefined;
	// Split on commas outside quotes and angle brackets.
	const items: string[] = [];
	let current = '';
	let quoted = false;
	let angle = false;
	for (const ch of value) {
		if (ch === '"') quoted = !quoted;
		else if (ch === '<' && !quoted) angle = true;
		else if (ch === '>' && !quoted) angle = false;
		if (ch === ',' && !quoted && !angle) {
			items.push(current);
			current = '';
		} else current += ch;
	}
	items.push(current);
	const out = items
		.map((item) => item.trim())
		.filter(Boolean)
		.map((item) => {
			const m = /^(.*?)\s*<([^>]*)>$/.exec(item);
			const name = m ? m[1].trim().replace(/^"(.*)"$/, '$1') : '';
			const addr = m ? m[2] : item;
			const at = addr.lastIndexOf('@');
			const mailbox = at < 0 ? addr : addr.slice(0, at);
			const host = at < 0 ? '' : addr.slice(at + 1);
			return `(${name ? str(name) : 'NIL'} NIL ${str(mailbox)} ${str(host)})`;
		});
	return out.length ? `(${out.join('')})` : undefined;
}
