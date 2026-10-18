import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startInstance } from '../api/harness';
import type { Instance } from '../api/harness';
import { eventually, node, seed, setNode, workflow } from '../webhooks/fixtures';
import {
	connectionAction,
	connectionState,
	deactivate,
	finishedExecutions,
	outputOf,
	storeCredential,
	tryActivate,
	withCredential,
} from './connection-fixtures';
import { startAmqpBroker } from './fakes/amqp-broker';
import { rfc822, startImapServer } from './fakes/imap-server';
import { startKafkaBroker } from './fakes/kafka-broker';
import { startMqttBroker } from './fakes/mqtt-broker';
import { startPgServer } from './fakes/pg-server';
import { startRheaBroker } from './fakes/rhea-broker';
import { startSnowflakeServer } from './fakes/snowflake-server';

/**
 * Triggers with persistent connections run in a TriggerConnection Durable Object per trigger
 * node. These tests run the stock nodes against in-process fake brokers (or a real
 * redis-server) on local TCP ports, so items flow from a real socket in workerd into an execution.
 */
describe('persistent connection triggers and socket nodes', () => {
	let instance: Instance;
	beforeAll(async () => {
		instance = await startInstance();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	async function activateOk(id: string) {
		expect(await tryActivate(instance, id)).toEqual({ status: 200, body: { active: true } });
	}

	/** Runs `data` once in manual mode up to `destination`, then returns the execution id. */
	async function runManually(
		data: ReturnType<typeof workflow>,
		destination: string,
	): Promise<string> {
		const response = await instance.worker.fetch(`${instance.origin}/__test/run`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				workflowData: { ...data, active: false },
				executionMode: 'manual',
				destinationNode: { nodeName: destination, mode: 'inclusive' },
			}),
		});
		expect(response.status).toBe(200);
		return ((await response.json()) as { executionId: string }).executionId;
	}

	async function finishedRun(id: string, executionId: string) {
		let row: Record<string, unknown> | undefined;
		await eventually(async () => {
			row = (await finishedExecutions(instance, id)).find(
				(candidate) => String(candidate.id) === executionId,
			);
			expect(row).toBeDefined();
		}, 30_000);
		return row!;
	}

	describe('MQTT', () => {
		let broker: Awaited<ReturnType<typeof startMqttBroker>>;
		beforeAll(async () => {
			broker = await startMqttBroker();
		});
		afterAll(async () => await broker?.close());

		const credential = (port: number) => ({
			protocol: 'mqtt',
			host: '127.0.0.1',
			port,
			username: 'n8n',
			password: 'secret',
			clean: true,
			clientId: '',
			ssl: false,
		});

		it('Trigger: starts executions from broker messages, survives an eviction and closes on deactivation', async () => {
			const id = 'mqtt-trigger';
			seed(
				instance,
				workflow(id, [
					withCredential(
						node('MQTT', 'mqttTrigger', {
							topics: 'sensors/#',
							options: { jsonParseBody: true, parallelProcessing: false },
						}),
						'mqtt',
						'mqtt-cred',
					),
					setNode(),
				]),
			);
			await storeCredential(instance, id, 'mqtt-cred', 'mqtt', credential(broker.port));
			await activateOk(id);
			expect(broker.subscriptions()).toContain('sensors/#');
			expect(broker.usernames).toContain('n8n');
			expect(await connectionState(instance, id, 'MQTT')).toMatchObject({
				configured: true,
				connected: true,
			});

			broker.publish('sensors/kitchen', JSON.stringify({ celsius: 21 }));
			await eventually(async () => expect(await finishedExecutions(instance, id)).toHaveLength(1));
			const [first] = await finishedExecutions(instance, id);
			expect(first).toMatchObject({ mode: 'trigger', status: 'success' });
			expect(await outputOf(instance, first.id, 'MQTT')).toEqual([
				{ topic: 'sensors/kitchen', message: { celsius: 21 } },
			]);
			expect(await outputOf(instance, first.id, 'Set')).toEqual([
				expect.objectContaining({ result: 'worked' }),
			]);

			// An eviction drops memory and sockets. The watchdog alarm connects again.
			await connectionAction(instance, id, 'MQTT', 'evict');
			await eventually(async () => expect(broker.clients()).toBe(0));
			await connectionAction(instance, id, 'MQTT', 'fire-alarm');
			await eventually(async () => {
				expect(broker.clients()).toBe(1);
				expect(await connectionState(instance, id, 'MQTT')).toMatchObject({ connected: true });
			});
			broker.publish('sensors/hall', JSON.stringify({ celsius: 19 }));
			await eventually(async () => expect(await finishedExecutions(instance, id)).toHaveLength(2));
			expect(
				await outputOf(instance, (await finishedExecutions(instance, id))[1].id, 'MQTT'),
			).toEqual([{ topic: 'sensors/hall', message: { celsius: 19 } }]);

			await deactivate(instance, id);
			await eventually(async () => expect(broker.clients()).toBe(0));
			expect(await connectionState(instance, id, 'MQTT')).toMatchObject({
				configured: false,
				connected: false,
				alarm: null,
			});
			broker.publish('sensors/kitchen', JSON.stringify({ celsius: 30 }));
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(await finishedExecutions(instance, id)).toHaveLength(2);
		});

		it('Trigger: fails the activation when the broker refuses the connection', async () => {
			const id = 'mqtt-refused';
			seed(
				instance,
				workflow(id, [
					withCredential(
						node('MQTT', 'mqttTrigger', { topics: 'a', options: {} }),
						'mqtt',
						'mqtt-bad',
					),
					setNode(),
				]),
			);
			await storeCredential(instance, id, 'mqtt-bad', 'mqtt', { ...credential(1), username: '' });
			const result = await tryActivate(instance, id);
			expect(result.status).toBe(500);
			expect(result.body.message).toBeTruthy();
			expect(await connectionState(instance, id, 'MQTT')).toMatchObject({
				configured: false,
				alarm: null,
			});
		});

		it('Trigger: a manual test run waits for one message', async () => {
			const id = 'mqtt-manual';
			const data = workflow(id, [
				withCredential(
					node('MQTT', 'mqttTrigger', { topics: 'manual/topic', options: {} }),
					'mqtt',
					'mqtt-manual',
				),
				setNode(),
			]);
			seed(instance, data);
			await storeCredential(instance, id, 'mqtt-manual', 'mqtt', credential(broker.port));
			const executionId = await runManually(data, 'MQTT');
			await eventually(async () => expect(broker.subscriptions()).toContain('manual/topic'));
			broker.publish('manual/topic', 'hello');
			const row = await finishedRun(id, executionId);
			expect(row.status).toBe('success');
			expect(await outputOf(instance, executionId, 'MQTT')).toEqual([
				{ topic: 'manual/topic', message: 'hello' },
			]);
		});

		it('node: publishes items to the broker', async () => {
			const id = 'mqtt-send';
			const data = workflow(id, [
				node('Manual', 'manualTrigger', {}),
				withCredential(
					node('MQTT', 'mqtt', {
						topic: 'out/topic',
						sendInputData: false,
						message: 'from n8n',
						options: {},
					}),
					'mqtt',
					'mqtt-send',
				),
			]);
			seed(instance, data);
			await storeCredential(instance, id, 'mqtt-send', 'mqtt', credential(broker.port));
			const row = await finishedRun(id, await runManually(data, 'MQTT'));
			expect(row.status).toBe('success');
			expect(broker.published).toContainEqual(
				expect.objectContaining({ topic: 'out/topic', payload: 'from n8n' }),
			);
		});
	});

	describe('RabbitMQ (AMQP 0-9-1)', () => {
		let broker: Awaited<ReturnType<typeof startAmqpBroker>>;
		beforeAll(async () => {
			broker = await startAmqpBroker();
		});
		afterAll(async () => await broker?.close());

		it('Trigger and node: consumes, acks after the execution finishes, and publishes the result', async () => {
			const id = 'rabbitmq';
			const credential = {
				hostname: '127.0.0.1',
				port: broker.port,
				username: 'guest',
				password: 'guest',
				vhost: '/',
				ssl: false,
			};
			seed(
				instance,
				workflow(id, [
					withCredential(
						node('RabbitMQ Trigger', 'rabbitmqTrigger', {
							queue: 'jobs',
							options: { jsonParseBody: true, onlyContent: true, acknowledge: 'executionFinishes' },
						}),
						'rabbitmq',
						'rabbit-cred',
					),
					withCredential(
						node(
							'RabbitMQ',
							'rabbitmq',
							{
								operation: 'sendMessage',
								mode: 'queue',
								queue: 'results',
								sendInputData: true,
								options: {},
							},
							1.2,
						),
						'rabbitmq',
						'rabbit-cred',
					),
				]),
			);
			await storeCredential(instance, id, 'rabbit-cred', 'rabbitmq', credential);
			// The nodes check that their queues exist. A message waiting in "jobs" arrives first.
			broker.declare('results');
			broker.send('jobs', JSON.stringify({ job: 1 }));
			await activateOk(id);
			await eventually(async () => expect(broker.consumers('jobs')).toBe(1));
			broker.send('jobs', JSON.stringify({ job: 2 }));

			await eventually(async () => expect(broker.acked).toHaveLength(2), 30_000);
			expect(broker.acked).toEqual([JSON.stringify({ job: 1 }), JSON.stringify({ job: 2 })]);
			const rows = await finishedExecutions(instance, id);
			expect(rows.map((row) => row.status)).toEqual(['success', 'success']);
			expect(await outputOf(instance, rows[0].id, 'RabbitMQ Trigger')).toEqual([{ job: 1 }]);
			const sent = broker.published.filter((message) => message.routingKey === 'results');
			expect(sent.map((message) => JSON.parse(message.body))).toEqual([{ job: 1 }, { job: 2 }]);

			await deactivate(instance, id);
			await eventually(async () => expect(broker.consumers('jobs')).toBe(0));
		});
	});

	describe('AMQP 1.0', () => {
		let broker: Awaited<ReturnType<typeof startRheaBroker>>;
		beforeAll(async () => {
			broker = await startRheaBroker();
		});
		afterAll(async () => await broker?.close());

		it('Trigger and node: receives from one address and sends to another', async () => {
			const id = 'amqp';
			seed(
				instance,
				workflow(id, [
					withCredential(
						node('AMQP Trigger', 'amqpTrigger', {
							sink: 'incoming',
							options: { jsonParseBody: true, onlyBody: true },
						}),
						'amqp',
						'amqp-cred',
					),
					withCredential(
						node('AMQP', 'amqp', { sink: 'outgoing', options: {} }),
						'amqp',
						'amqp-cred',
					),
				]),
			);
			await storeCredential(instance, id, 'amqp-cred', 'amqp', {
				hostname: '127.0.0.1',
				port: broker.port,
				username: '',
				password: '',
			});
			await activateOk(id);
			await eventually(async () => expect(broker.receivers('incoming')).toBe(1));
			broker.send('incoming', JSON.stringify({ order: 7 }));
			await eventually(async () => expect(broker.received('outgoing')).toHaveLength(1), 30_000);
			expect(JSON.parse(String(broker.received('outgoing')[0]))).toEqual({ order: 7 });
			const [row] = await finishedExecutions(instance, id);
			expect(row.status).toBe('success');
			expect(await outputOf(instance, row.id, 'AMQP Trigger')).toEqual([{ order: 7 }]);
			await deactivate(instance, id);
			await eventually(async () => expect(broker.receivers('incoming')).toBe(0));
		});
	});

	describe('Redis', () => {
		const redisServer = spawnSync('which', ['redis-server'], { encoding: 'utf8' }).stdout.trim();
		let server: ChildProcess | undefined;
		let port = 0;
		beforeAll(async () => {
			if (!redisServer) return;
			port = await freePort();
			server = spawn(redisServer, ['--port', String(port), '--save', '', '--appendonly', 'no'], {
				stdio: 'ignore',
			});
			await eventually(async () => {
				await new Promise<void>((resolve, reject) => {
					const socket = connect(port, '127.0.0.1', () => {
						socket.end();
						resolve();
					});
					socket.on('error', reject);
				});
			}, 10_000);
		});
		afterAll(() => {
			server?.kill();
		});

		it.skipIf(!redisServer)(
			'Trigger and node: a published message starts an execution that publishes again',
			async () => {
				const id = 'redis';
				seed(
					instance,
					workflow(id, [
						withCredential(
							node('Redis Trigger', 'redisTrigger', {
								channels: 'orders',
								options: { jsonParseBody: true },
							}),
							'redis',
							'redis-cred',
						),
						withCredential(
							node('Redis', 'redis', {
								operation: 'publish',
								channel: 'processed',
								messageData: '={{ JSON.stringify($json.message) }}',
							}),
							'redis',
							'redis-cred',
						),
					]),
				);
				await storeCredential(instance, id, 'redis-cred', 'redis', {
					host: '127.0.0.1',
					port,
					database: 0,
					password: '',
					ssl: false,
				});
				await activateOk(id);
				const subscriber = spawn('redis-cli', ['-p', String(port), 'SUBSCRIBE', 'processed']);
				let seen = '';
				subscriber.stdout.on('data', (chunk: Buffer) => (seen += chunk.toString()));
				await eventually(async () => expect(seen).toContain('processed'));
				spawnSync('redis-cli', [
					'-p',
					String(port),
					'PUBLISH',
					'orders',
					JSON.stringify({ id: 42 }),
				]);
				await eventually(async () => expect(seen).toContain('{"id":42}'), 30_000);
				subscriber.kill();
				const [row] = await finishedExecutions(instance, id);
				expect(row.status).toBe('success');
				expect(await outputOf(instance, row.id, 'Redis Trigger')).toEqual([
					{ channel: 'orders', message: { id: 42 } },
				]);
				await deactivate(instance, id);
			},
		);
	});

	describe('Postgres Trigger (LISTEN)', () => {
		let server: Awaited<ReturnType<typeof startPgServer>>;
		beforeAll(async () => {
			server = await startPgServer();
		});
		afterAll(async () => await server?.close());

		it('starts an execution for each notification and unlistens on deactivation', async () => {
			const id = 'postgres-listen';
			seed(
				instance,
				workflow(id, [
					withCredential(
						{
							// The node builds Postgres object names from its id, which the editor sets to a UUID.
							...node('Postgres Trigger', 'postgresTrigger', {
								triggerMode: 'listenTrigger',
								channelName: 'events',
								additionalFields: {},
							}),
							id: '5f2b7c1e-0d3a-4b8e-9c6f-1a2b3c4d5e6f',
						},
						'postgres',
						'pg-cred',
					),
					setNode(),
				]),
			);
			await storeCredential(instance, id, 'pg-cred', 'postgres', {
				host: '127.0.0.1',
				port: server.port,
				database: 'n8n',
				user: 'n8n',
				password: 'secret',
				ssl: 'disable',
			});
			await activateOk(id);
			expect(server.listening()).toContain('events');
			server.notify('events', JSON.stringify({ table: 'orders', id: 3 }));
			await eventually(async () => expect(await finishedExecutions(instance, id)).toHaveLength(1));
			const [row] = await finishedExecutions(instance, id);
			expect(row.status).toBe('success');
			expect(await outputOf(instance, row.id, 'Postgres Trigger')).toEqual([
				expect.objectContaining({ channel: 'events', payload: { table: 'orders', id: 3 } }),
			]);
			await deactivate(instance, id);
			await eventually(async () => expect(server.listening()).not.toContain('events'));
		});
	});

	describe('Email Trigger (IMAP)', () => {
		let server: Awaited<ReturnType<typeof startImapServer>>;
		beforeAll(async () => {
			server = await startImapServer();
		});
		afterAll(async () => await server?.close());

		it('emits new mail, marks it read, and keeps the last UID across a reconnect', async () => {
			const id = 'imap';
			seed(
				instance,
				workflow(id, [
					withCredential(
						node(
							'Email Trigger',
							'emailReadImap',
							{ mailbox: 'INBOX', postProcessAction: 'read', format: 'simple', options: {} },
							2.2,
						),
						'imap',
						'imap-cred',
					),
					setNode(),
				]),
			);
			await storeCredential(instance, id, 'imap-cred', 'imap', {
				user: 'user',
				password: 'pass',
				host: '127.0.0.1',
				port: server.port,
				secure: false,
				allowUnauthorizedCerts: true,
			});
			await activateOk(id);
			await eventually(async () => expect(server.selectedClients()).toBe(1));
			const uid = server.addMessage(rfc822('Invoice 1', 'Please pay.'));
			await eventually(
				async () => expect(await finishedExecutions(instance, id)).toHaveLength(1),
				30_000,
			);
			const [row] = await finishedExecutions(instance, id);
			expect(row.status).toBe('success');
			expect(await outputOf(instance, row.id, 'Email Trigger')).toEqual([
				expect.objectContaining({
					subject: 'Invoice 1',
					textPlain: expect.stringContaining('Please pay.'),
				}),
			]);
			await eventually(async () => expect(server.flags(uid)).toContain('\\Seen'));

			await connectionAction(instance, id, 'Email Trigger', 'evict');
			await eventually(async () => expect(server.selectedClients()).toBe(0));
			await connectionAction(instance, id, 'Email Trigger', 'fire-alarm');
			await eventually(async () => expect(server.selectedClients()).toBe(1));
			server.addMessage(rfc822('Invoice 2', 'Second one.'));
			await eventually(
				async () => expect(await finishedExecutions(instance, id)).toHaveLength(2),
				30_000,
			);
			expect(
				await outputOf(instance, (await finishedExecutions(instance, id))[1].id, 'Email Trigger'),
			).toEqual([expect.objectContaining({ subject: 'Invoice 2' })]);
			await deactivate(instance, id);
			await eventually(async () => expect(server.selectedClients()).toBe(0));
		});
	});

	describe('Kafka', () => {
		let broker: Awaited<ReturnType<typeof startKafkaBroker>>;
		beforeAll(async () => {
			broker = await startKafkaBroker();
		});
		afterAll(async () => await broker?.close());

		it('Trigger and node: consumes a topic in a group, commits after the execution, and produces', async () => {
			const id = 'kafka';
			broker.produce('orders', JSON.stringify({ order: 1 }));
			seed(
				instance,
				workflow(id, [
					withCredential(
						node(
							'Kafka Trigger',
							'kafkaTrigger',
							{
								topic: 'orders',
								groupId: 'n8n-group',
								options: { fromBeginning: true, jsonParseMessage: true, onlyMessage: true },
							},
							2,
						),
						'kafka',
						'kafka-cred',
					),
					withCredential(
						node(
							'Kafka',
							'kafka',
							{ topic: 'invoices', sendInputData: true, jsonParameters: false, options: {} },
							2,
						),
						'kafka',
						'kafka-cred',
					),
				]),
			);
			await storeCredential(instance, id, 'kafka-cred', 'kafka', {
				clientId: 'n8n',
				brokers: `127.0.0.1:${broker.port}`,
				ssl: false,
				authentication: false,
			});
			await activateOk(id);
			await eventually(async () => expect(broker.groupMembers('n8n-group')).toBe(1), 30_000);
			broker.produce('orders', JSON.stringify({ order: 2 }));
			await eventually(
				async () => expect(broker.produced.filter((r) => r.topic === 'invoices')).toHaveLength(2),
				40_000,
			);
			expect(
				broker.produced.filter((r) => r.topic === 'invoices').map((r) => JSON.parse(r.value!)),
			).toEqual([{ order: 1 }, { order: 2 }]);
			await eventually(
				async () => expect(Number(broker.committed('n8n-group', 'orders'))).toBe(2),
				30_000,
			);
			expect((await finishedExecutions(instance, id)).map((row) => row.status)).toEqual([
				'success',
				'success',
			]);
			await deactivate(instance, id);
			await eventually(async () => expect(broker.groupMembers('n8n-group')).toBe(0), 30_000);
		}, 120_000);
	});

	describe('Snowflake', () => {
		let server: Awaited<ReturnType<typeof startSnowflakeServer>>;
		beforeAll(async () => {
			server = await startSnowflakeServer();
		});
		afterAll(async () => await server?.close());

		it('node: runs a query through snowflake-sdk and returns the rows', async () => {
			const id = 'snowflake';
			const data = workflow(id, [
				node('Manual', 'manualTrigger', {}),
				withCredential(
					node(
						'Snowflake',
						'snowflake',
						{ operation: 'executeQuery', query: 'SELECT ID, NAME FROM USERS' },
						1.1,
					),
					'snowflake',
					'snowflake-cred',
				),
			]);
			seed(instance, data);
			await storeCredential(instance, id, 'snowflake-cred', 'snowflake', {
				// The test worker sends local-<port>.snowflakecomputing.com to the fake server.
				account: `local-${server.port}`,
				database: 'DB',
				warehouse: 'WH',
				schema: 'PUBLIC',
				role: 'R',
				authentication: 'password',
				username: 'alice',
				password: 'secret',
			});
			const executionId = await runManually(data, 'Snowflake');
			const row = await finishedRun(id, executionId);
			expect(row.status).toBe('success');
			expect(await outputOf(instance, executionId, 'Snowflake')).toEqual([
				{ ID: 1, NAME: 'alice' },
				{ ID: 2, NAME: 'bob' },
			]);
			expect(server.logins).toEqual([
				expect.objectContaining({ LOGIN_NAME: 'alice', ACCOUNT_NAME: `local-${server.port}` }),
			]);
			expect(server.queries).toContain('SELECT ID, NAME FROM USERS');
		});
	});
});

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => resolve(port));
		});
		server.on('error', reject);
	});
}
