import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { getPlatformProxy } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { R2ByteStore, r2KeyOf } from '../../src/runtime/r2-byte-store';

const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

async function collect(stream: Readable): Promise<Buffer[]> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return chunks;
}

describe('R2ByteStore', () => {
	let dispose: () => Promise<void>;
	let bucket: R2Bucket;
	let store: R2ByteStore;
	let multipartUploads = 0;

	beforeAll(async () => {
		const dir = mkdtempSync(join(tmpdir(), 'r2-store-'));
		const configPath = join(dir, 'wrangler.json');
		writeFileSync(
			configPath,
			JSON.stringify({
				name: 'r2-store',
				compatibility_date: '2025-09-01',
				r2_buckets: [{ binding: 'STORAGE', bucket_name: 'test' }],
			}),
		);
		const proxy = await getPlatformProxy<{ STORAGE: R2Bucket }>({ configPath, persist: false });
		dispose = proxy.dispose;
		bucket = proxy.env.STORAGE;
		const counted = new Proxy(bucket, {
			get(target, property) {
				const value: unknown = Reflect.get(target, property);
				if (property === 'createMultipartUpload') {
					return (...args: Parameters<R2Bucket['createMultipartUpload']>) => {
						multipartUploads++;
						return target.createMultipartUpload(...args);
					};
				}
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		store = new R2ByteStore(counted);
	}, 60_000);

	afterAll(async () => {
		await dispose?.();
	});

	it('writes a stream of unknown length as a multipart upload without buffering it whole', async () => {
		const big = randomBytes(20 * 1024 * 1024 + 123);
		const pieces = Array.from({ length: Math.ceil(big.length / 65536) }, (_, i) =>
			big.subarray(i * 65536, (i + 1) * 65536),
		);
		const before = multipartUploads;
		const written = await store.write(
			'workflows/w1/executions/7/binary_data/big',
			Readable.from(pieces),
			{
				mimeType: 'application/octet-stream',
				fileName: 'big.bin',
			},
		);
		expect(written).toBe(big.length);
		expect(multipartUploads).toBe(before + 1);
		expect(await store.getMetadata('workflows/w1/executions/7/binary_data/big')).toEqual({
			fileName: 'big.bin',
			mimeType: 'application/octet-stream',
			fileSize: big.length,
		});
		expect(sha((await store.read('workflows/w1/executions/7/binary_data/big'))!)).toBe(sha(big));
		expect(await bucket.head('binary/7/w1/big')).not.toBeNull();
	});

	it('writes small streams and empty streams with one put', async () => {
		const before = multipartUploads;
		expect(
			await store.write('custom/small', Readable.from([Buffer.from('abc'), Buffer.from('def')])),
		).toBe(6);
		expect(await store.write('custom/empty', Readable.from([]))).toBe(0);
		expect(multipartUploads).toBe(before);
		expect((await store.read('custom/small'))?.toString()).toBe('abcdef');
		expect((await store.read('custom/empty'))?.length).toBe(0);
	});

	it('writes a buffer with one put', async () => {
		expect(await store.write('custom/buffer', Buffer.from('xyz'))).toBe(3);
		expect((await store.read('custom/buffer'))?.toString()).toBe('xyz');
	});

	it('streams a stored object in chunks of the requested size', async () => {
		const data = randomBytes(2_500_000);
		await store.write('custom/chunks', data);
		const chunks = await collect(
			(await store.readStream('custom/chunks', { chunkSize: 1_000_000 }))!,
		);
		expect(chunks.map((c) => c.length)).toEqual([1_000_000, 1_000_000, 500_000]);
		expect(sha(Buffer.concat(chunks))).toBe(sha(data));
		expect(sha(Buffer.concat(await collect((await store.readStream('custom/chunks'))!)))).toBe(
			sha(data),
		);
		expect(await store.readStream('custom/missing')).toBeNull();
	});

	it('stops reading the object when the consumer destroys the stream', async () => {
		await store.write('custom/cancel', randomBytes(3_000_000));
		const stream = (await store.readStream('custom/cancel', { chunkSize: 100_000 }))!;
		const first = await stream[Symbol.asyncIterator]().next();
		expect(Buffer.from(first.value).length).toBe(100_000);
		stream.destroy();
		await once(stream, 'close');
		expect(stream.destroyed).toBe(true);
	});

	it('copies and renames with metadata and without reading into memory', async () => {
		await store.write('custom/source', Buffer.from('payload'), {
			mimeType: 'text/plain',
			fileName: 'p.txt',
		});
		await store.copy('custom/source', 'custom/copy');
		await store.rename('custom/copy', 'custom/renamed');
		expect(await store.getMetadata('custom/copy')).toBeNull();
		expect(await store.getMetadata('custom/renamed')).toEqual({
			fileName: 'p.txt',
			mimeType: 'text/plain',
			fileSize: 7,
		});
		await store.delete(['custom/source', 'custom/renamed']);
		expect(await store.read('custom/source')).toBeNull();
	});

	it('maps execution binaries under their execution id', () => {
		expect(r2KeyOf('workflows/w/executions/9/binary_data/u')).toBe('binary/9/w/u');
	});
});
