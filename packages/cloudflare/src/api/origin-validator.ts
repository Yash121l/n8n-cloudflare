/** Port of `validateWebSocketOrigin` from stock `push/origin-validator.ts`. */

type Protocol = 'http' | 'https';

const defaultPort = (protocol: Protocol) => (protocol === 'https' ? '443' : '80');

function stripIpv6Brackets(host: string): string {
	const withPort = host.indexOf(']:');
	if (host.startsWith('[') && withPort !== -1)
		return `${host.slice(1, withPort)}:${host.slice(withPort + 2)}`;
	if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
	return host;
}

/** Drops the default port of the protocol and the IPv6 brackets. */
function normalizeHost(host: string, protocol: Protocol): string {
	if (!host) return host;
	try {
		const url = new URL(`${protocol}://${host}`);
		return stripIpv6Brackets(
			(url.port || defaultPort(protocol)) === defaultPort(protocol) ? url.hostname : url.host,
		);
	} catch {
		return host;
	}
}

function toProtocol(value: string | undefined): Protocol | undefined {
	const normalized = value?.toLowerCase().trim();
	return normalized === 'http' || normalized === 'https' ? normalized : undefined;
}

function parseOrigin(origin: string): { protocol: Protocol; host: string } | null {
	if (!origin) return null;
	try {
		const url = new URL(origin);
		const protocol = toProtocol(url.protocol.slice(0, -1));
		if (!protocol) return null;
		return { protocol, host: normalizeHost(url.host, protocol) };
	} catch {
		return null;
	}
}

/** Reads the first entry of an RFC 7239 `Forwarded` header. */
function parseForwarded(header: string): { host?: string; proto?: string } {
	const result: { host?: string; proto?: string } = {};
	for (const pair of (header.split(',')[0] ?? '').split(';')) {
		const [key, value] = pair.split('=', 2);
		if (!key || !value) continue;
		const clean = value.trim().replace(/^["']|["']$/g, '');
		const name = key.trim().toLowerCase();
		if (name === 'host') result.host = clean;
		else if (name === 'proto') result.proto = clean;
	}
	return result;
}

/**
 * WebSocket handshakes always carry an `Origin` (RFC 6455), so a missing, malformed or non-HTTP
 * origin fails. The expected host comes from `Forwarded`, then `X-Forwarded-Host`, then `Host`.
 */
export function isValidWebSocketOrigin(
	header: (name: string) => string | undefined,
	requestHost: string,
): boolean {
	const origin = parseOrigin(header('origin') ?? '');
	if (!origin) return false;

	let expectedProtocol = origin.protocol;
	let rawHost: string | undefined;
	const forwarded = parseForwarded(header('forwarded') ?? '');
	if (forwarded.host) {
		rawHost = forwarded.host;
		expectedProtocol = toProtocol(forwarded.proto) ?? expectedProtocol;
	} else {
		const forwardedHost = header('x-forwarded-host');
		if (forwardedHost) {
			rawHost = forwardedHost;
			expectedProtocol = toProtocol(header('x-forwarded-proto')?.split(',')[0]) ?? expectedProtocol;
		} else {
			rawHost = header('host') ?? requestHost;
		}
	}
	return normalizeHost(rawHost, expectedProtocol) === origin.host;
}
