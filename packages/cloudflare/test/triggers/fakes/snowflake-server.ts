// A tiny fake of the Snowflake HTTP endpoints that snowflake-sdk uses: login, query, logout.
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { gunzipSync } from 'node:zlib';

export interface FakeSnowflakeServer {
	port: number;
	/** `data` of each login request body. */
	logins: Array<Record<string, unknown>>;
	/** SQL text of each query, in order. */
	queries: string[];
	close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	let body = Buffer.concat(chunks);
	if (request.headers['content-encoding'] === 'gzip' || (body[0] === 0x1f && body[1] === 0x8b))
		body = gunzipSync(body);
	const text = body.toString('utf8');
	return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const column = (name: string, type: 'fixed' | 'text') => ({
	name,
	type,
	nullable: true,
	scale: type === 'fixed' ? 0 : null,
	precision: type === 'fixed' ? 38 : null,
	length: type === 'text' ? 16777216 : null,
	byteLength: type === 'text' ? 16777216 : null,
	database: 'DB',
	schema: 'PUBLIC',
	table: 'USERS',
	collation: null,
});

function queryResult(sqlText: string) {
	const isSelect = /^\s*select/i.test(sqlText);
	return {
		success: true,
		code: null,
		message: null,
		data: {
			parameters: [],
			rowtype: isSelect
				? [column('ID', 'fixed'), column('NAME', 'text')]
				: [column('status', 'text')],
			rowset: isSelect
				? [
						['1', 'alice'],
						['2', 'bob'],
					]
				: [['Statement executed successfully.']],
			total: isSelect ? 2 : 1,
			returned: isSelect ? 2 : 1,
			queryId: `query-${Date.now()}`,
			databaseProvider: null,
			finalDatabaseName: 'DB',
			finalSchemaName: 'PUBLIC',
			finalWarehouseName: 'WH',
			finalRoleName: 'R',
			numberOfBinds: 0,
			arrayBindSupported: false,
			statementTypeId: isSelect ? 4096 : 12544,
			version: 1,
			sendResultTime: Date.now(),
			queryResultFormat: 'json',
		},
	};
}

export async function startSnowflakeServer(): Promise<FakeSnowflakeServer> {
	const logins: FakeSnowflakeServer['logins'] = [];
	const queries: string[] = [];
	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? '/', 'http://localhost');
			const body = await readBody(request);
			let reply: unknown = { success: true, code: null, message: null, data: null };
			if (url.pathname === '/session/v1/login-request') {
				logins.push((body.data as Record<string, unknown>) ?? {});
				reply = {
					success: true,
					code: null,
					message: null,
					data: {
						token: 'session-token',
						masterToken: 'master-token',
						validityInSeconds: 3600,
						masterValidityInSeconds: 14400,
						displayUserName: 'ALICE',
						serverVersion: '9.0.0',
						firstLogin: false,
						remMeToken: null,
						remMeValidityInSeconds: 0,
						healthCheckInterval: 45,
						newClientForUpgrade: null,
						sessionId: 1,
						parameters: [],
						sessionInfo: {
							databaseName: 'DB',
							schemaName: 'PUBLIC',
							warehouseName: 'WH',
							roleName: 'R',
						},
					},
				};
			} else if (url.pathname === '/queries/v1/query-request') {
				const sqlText = String(body.sqlText ?? '');
				queries.push(sqlText);
				reply = queryResult(sqlText);
			}
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify(reply));
		})().catch((error: unknown) => {
			response.writeHead(500);
			response.end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	return {
		port,
		logins,
		queries,
		close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
