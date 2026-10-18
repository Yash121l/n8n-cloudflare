/**
 * Replaces `@confluentinc/kafka-javascript` in the worker bundle. That library wraps the native
 * librdkafka addon, which cannot load on Workers. The v2 Kafka nodes use only its KafkaJS
 * compatible API, so this module provides that API on top of kafkajs, which speaks the Kafka
 * protocol over node:net and node:tls. build.mjs points imports of the library here.
 *
 * Covered: what packages/nodes-base/nodes/Kafka/v2 uses. Kafka, admin().fetchTopicMetadata,
 * producer().sendBatch, consumer() with subscribe, run, assignment, and the logger contract.
 */
import {
	CompressionTypes as KafkaJSCompression,
	Kafka as KafkaJSClient,
	logLevel as kafkaJSLogLevel,
} from 'kafkajs';
import type {
	Admin as KafkaJSAdmin,
	Consumer as KafkaJSConsumer,
	ConsumerRunConfig,
	KafkaConfig as KafkaJSConfig,
	LogEntry,
	Producer as KafkaJSProducer,
	ProducerBatch,
	SASLOptions,
} from 'kafkajs';

/** Same numbers as kafkajs and the library. */
export const logLevel = { NOTHING: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4 } as const;

/** Kafka protocol error codes. kafkajs errors carry the same numbers in `code`. */
export const ErrorCodes = {
	ERR_UNKNOWN: -1,
	ERR_NO_ERROR: 0,
	ERR_OFFSET_OUT_OF_RANGE: 1,
	ERR_UNKNOWN_TOPIC_OR_PART: 3,
	ERR_LEADER_NOT_AVAILABLE: 5,
	ERR_NOT_LEADER_FOR_PARTITION: 6,
	ERR_REQUEST_TIMED_OUT: 7,
	ERR_TOPIC_EXCEPTION: 17,
	ERR_TOPIC_AUTHORIZATION_FAILED: 29,
	ERR_GROUP_AUTHORIZATION_FAILED: 30,
	ERR_SASL_AUTHENTICATION_FAILED: 58,
	ERR__STATE: -172,
} as const;

export const CompressionTypes = {
	None: 'none',
	GZIP: 'gzip',
	SNAPPY: 'snappy',
	LZ4: 'lz4',
	ZSTD: 'zstd',
} as const;

const COMPRESSION: Record<string, KafkaJSCompression> = {
	none: KafkaJSCompression.None,
	gzip: KafkaJSCompression.GZIP,
	snappy: KafkaJSCompression.Snappy,
	lz4: KafkaJSCompression.LZ4,
	zstd: KafkaJSCompression.ZSTD,
};

export interface Logger {
	info(message: string, extra?: object): void;
	warn(message: string, extra?: object): void;
	error(message: string, extra?: object): void;
	debug(message: string, extra?: object): void;
	namespace?(name: string): Logger;
	setLogLevel?(level: number): void;
}

interface KafkaJSBlock {
	brokers?: string[];
	clientId?: string;
	ssl?: boolean;
	sasl?: SASLOptions;
	logLevel?: number;
	logger?: Logger;
	connectionTimeout?: number;
	requestTimeout?: number;
	[key: string]: unknown;
}

export interface CommonConstructorConfig {
	kafkaJS?: KafkaJSBlock;
	'ssl.ca.pem'?: string;
	'ssl.certificate.pem'?: string;
	'ssl.key.pem'?: string;
	'enable.ssl.certificate.verification'?: boolean;
	[key: string]: unknown;
}

/** Routes kafkajs log entries to a library-style logger. */
function logCreator(logger: Logger) {
	const method = {
		[kafkaJSLogLevel.ERROR]: 'error',
		[kafkaJSLogLevel.WARN]: 'warn',
		[kafkaJSLogLevel.INFO]: 'info',
	} as const;
	return () =>
		({ level, log }: LogEntry) => {
			const { message, ...extra } = log;
			logger[method[level as keyof typeof method] ?? 'debug'](message, extra);
		};
}

function clientConfig(config: CommonConstructorConfig, logger?: Logger): KafkaJSConfig {
	const block = config.kafkaJS ?? {};
	const ca = config['ssl.ca.pem'];
	const cert = config['ssl.certificate.pem'];
	const key = config['ssl.key.pem'];
	const verify = config['enable.ssl.certificate.verification'] !== false;
	const ssl =
		block.ssl && (ca || cert || key || !verify)
			? {
					...(ca ? { ca: [ca] } : {}),
					...(cert ? { cert } : {}),
					...(key ? { key } : {}),
					rejectUnauthorized: verify,
				}
			: Boolean(block.ssl);
	const activeLogger = logger ?? block.logger;
	activeLogger?.setLogLevel?.(block.logLevel ?? logLevel.ERROR);
	return {
		brokers: block.brokers ?? [],
		clientId: block.clientId,
		ssl,
		sasl: block.sasl,
		connectionTimeout: block.connectionTimeout,
		requestTimeout: block.requestTimeout,
		logLevel: block.logLevel ?? kafkaJSLogLevel.ERROR,
		...(activeLogger ? { logCreator: logCreator(activeLogger) } : {}),
	};
}

interface ProducerBlock {
	acks?: number;
	timeout?: number;
	compression?: string;
	allowAutoTopicCreation?: boolean;
	logger?: Logger;
}

class Producer {
	constructor(
		private readonly producer: KafkaJSProducer,
		private readonly options: ProducerBlock,
	) {}

	async connect() {
		await this.producer.connect();
	}

	async disconnect() {
		await this.producer.disconnect();
	}

	async send(record: Parameters<KafkaJSProducer['send']>[0]) {
		return await this.producer.send({ ...this.defaults(), ...record });
	}

	async sendBatch(batch: ProducerBatch) {
		return await this.producer.sendBatch({ ...this.defaults(), ...batch });
	}

	private defaults() {
		const compression = COMPRESSION[this.options.compression ?? 'none'];
		return {
			...(this.options.acks === undefined ? {} : { acks: this.options.acks }),
			...(this.options.timeout === undefined ? {} : { timeout: this.options.timeout }),
			...(compression ? { compression } : {}),
		};
	}
}

interface ConsumerBlock {
	groupId: string;
	fromBeginning?: boolean;
	autoCommit?: boolean;
	autoCommitInterval?: number;
	sessionTimeout?: number;
	heartbeatInterval?: number;
	rebalanceTimeout?: number;
	maxBytesPerPartition?: number;
	minBytes?: number;
	maxWaitTimeInMs?: number;
	maxInFlightRequests?: number;
	logger?: Logger;
}

class Consumer {
	private assigned: Array<{ topic: string; partition: number }> = [];
	private connected = false;

	constructor(
		private readonly consumer: KafkaJSConsumer,
		private readonly options: ConsumerBlock,
		logger?: Logger,
	) {
		consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
			this.assigned = Object.entries(payload.memberAssignment).flatMap(([topic, partitions]) =>
				partitions.map((partition) => ({ topic, partition })),
			);
		});
		consumer.on(consumer.events.REBALANCING, () => {
			this.assigned = [];
		});
		// The library reports a consumer that stops for good through its logger. kafkajs emits CRASH.
		consumer.on(consumer.events.CRASH, ({ payload }) => {
			if (!payload.restart) logger?.error(payload.error.message, { groupId: payload.groupId });
		});
	}

	async connect() {
		await this.consumer.connect();
		this.connected = true;
	}

	async disconnect() {
		this.connected = false;
		this.assigned = [];
		await this.consumer.disconnect();
	}

	async subscribe({ topics, topic }: { topics?: Array<string | RegExp>; topic?: string | RegExp }) {
		await this.consumer.subscribe({
			topics: topics ?? (topic === undefined ? [] : [topic]),
			fromBeginning: this.options.fromBeginning ?? false,
		});
	}

	async run(config: ConsumerRunConfig) {
		await this.consumer.run({
			autoCommit: this.options.autoCommit ?? true,
			autoCommitInterval: this.options.autoCommitInterval,
			...config,
		});
	}

	/** Like the library, it throws ERR__STATE while the consumer is not connected. */
	assignment(): Array<{ topic: string; partition: number }> {
		if (!this.connected)
			throw Object.assign(new Error('The consumer is not connected'), {
				code: ErrorCodes.ERR__STATE,
			});
		return this.assigned;
	}

	async commitOffsets(offsets: Parameters<KafkaJSConsumer['commitOffsets']>[0]) {
		await this.consumer.commitOffsets(offsets);
	}

	pause(topics: Parameters<KafkaJSConsumer['pause']>[0]) {
		this.consumer.pause(topics);
	}

	resume(topics: Parameters<KafkaJSConsumer['resume']>[0]) {
		this.consumer.resume(topics);
	}

	seek(offset: Parameters<KafkaJSConsumer['seek']>[0]) {
		this.consumer.seek(offset);
	}
}

class Admin {
	constructor(private readonly admin: KafkaJSAdmin) {}

	async connect() {
		await this.admin.connect();
	}

	async disconnect() {
		await this.admin.disconnect();
	}

	async fetchTopicMetadata({ topics }: { topics?: string[]; timeout?: number } = {}) {
		const { topics: metadata } = await this.admin.fetchTopicMetadata({ topics: topics ?? [] });
		return metadata.map((topic) => ({ name: topic.name, partitions: topic.partitions }));
	}

	async listTopics() {
		return await this.admin.listTopics();
	}
}

export class Kafka {
	private readonly config: CommonConstructorConfig;

	constructor(config: CommonConstructorConfig) {
		this.config = config;
	}

	private client(logger?: Logger) {
		return new KafkaJSClient(clientConfig(this.config, logger));
	}

	producer(config: { kafkaJS?: ProducerBlock } = {}) {
		const options = config.kafkaJS ?? {};
		const producer = this.client(options.logger).producer({
			allowAutoTopicCreation: options.allowAutoTopicCreation ?? true,
		});
		return new Producer(producer, options);
	}

	consumer(config: { kafkaJS: ConsumerBlock }) {
		const options = config.kafkaJS;
		const consumer = this.client(options.logger).consumer({
			groupId: options.groupId,
			sessionTimeout: options.sessionTimeout,
			heartbeatInterval: options.heartbeatInterval,
			rebalanceTimeout: options.rebalanceTimeout,
			maxBytesPerPartition: options.maxBytesPerPartition,
			minBytes: options.minBytes,
			maxWaitTimeInMs: options.maxWaitTimeInMs,
			maxInFlightRequests: options.maxInFlightRequests,
		});
		return new Consumer(consumer, options, options.logger ?? this.config.kafkaJS?.logger);
	}

	admin(config: { kafkaJS?: { logger?: Logger } } = {}) {
		return new Admin(this.client(config.kafkaJS?.logger).admin());
	}
}

export const KafkaJS = { Kafka, logLevel, ErrorCodes, CompressionTypes };
export default { KafkaJS };
