import type { BlobMetadata, ByteStore, PreWriteBlobMetadata } from '@n8n/blob-storage';
import { Readable } from 'node:stream';

const EXECUTION_KEY = /^workflows\/([^/]+)\/executions\/([^/]+)\/binary_data\/(.+)$/;

/** Groups execution binaries by execution ID, so deleting an execution is one prefix. */
export function r2KeyOf(key: string): string {
	const match = key.match(EXECUTION_KEY);
	return match ? `binary/${match[2]}/${match[1]}/${match[3]}` : `binary/custom/${key}`;
}

/** R2 needs equal sizes for every part except the last, and at least 5 MiB for each part but the last. */
const PART_SIZE = 8 * 1024 * 1024;

/** Re-slices a stream of buffers into buffers of exactly `size` bytes. The last one can be smaller. */
async function* fixedChunks(
	source: AsyncIterable<Buffer | Uint8Array | string>,
	size: number,
): AsyncGenerator<Buffer> {
	let pending: Buffer[] = [];
	let length = 0;
	for await (const chunk of source) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		pending.push(buffer);
		length += buffer.length;
		if (length < size) continue;
		const joined = Buffer.concat(pending, length);
		let offset = 0;
		while (length - offset >= size) {
			yield joined.subarray(offset, offset + size);
			offset += size;
		}
		pending = offset < length ? [joined.subarray(offset)] : [];
		length -= offset;
	}
	if (length > 0) yield Buffer.concat(pending, length);
}

/** Streams the body of an R2 object without holding it in memory. */
async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
	const reader = body.getReader();
	let finished = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				return;
			}
			yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
		}
	} finally {
		if (!finished) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/** Binary data storage on R2. n8n-core's BinaryDataBlobManager drives it like its S3 store. */
export class R2ByteStore implements ByteStore {
	constructor(private readonly bucket: R2Bucket) {}

	async write(
		key: string,
		body: Buffer | Readable,
		metadata?: PreWriteBlobMetadata,
	): Promise<number> {
		const r2Key = r2KeyOf(key);
		const options: R2PutOptions = {
			httpMetadata: metadata?.mimeType ? { contentType: metadata.mimeType } : undefined,
			customMetadata: metadata?.fileName ? { fileName: metadata.fileName } : undefined,
		};
		if (!(body instanceof Readable)) {
			await this.bucket.put(r2Key, body, options);
			return body.length;
		}

		// The length of a stream is not known, so small bodies use one put and large ones a multipart upload.
		const parts = fixedChunks(body, PART_SIZE)[Symbol.asyncIterator]();
		const first = await parts.next();
		if (first.done) {
			await this.bucket.put(r2Key, new Uint8Array(0), options);
			return 0;
		}
		const second = await parts.next();
		if (second.done) {
			await this.bucket.put(r2Key, first.value, options);
			return first.value.length;
		}

		const upload = await this.bucket.createMultipartUpload(r2Key, options);
		const uploaded: R2UploadedPart[] = [];
		let size = 0;
		try {
			let part = first.value;
			let next: IteratorResult<Buffer> = second;
			for (let partNumber = 1; ; partNumber++) {
				uploaded.push(await upload.uploadPart(partNumber, part));
				size += part.length;
				if (next.done) break;
				part = next.value;
				next = await parts.next();
			}
			await upload.complete(uploaded);
		} catch (error) {
			await upload.abort().catch(() => undefined);
			throw error;
		}
		return size;
	}

	async read(key: string): Promise<Buffer | null> {
		const object = await this.bucket.get(r2KeyOf(key));
		return object ? Buffer.from(await object.arrayBuffer()) : null;
	}

	async readStream(key: string, opts?: { chunkSize?: number }): Promise<Readable | null> {
		const object = await this.bucket.get(r2KeyOf(key));
		if (!object) return null;
		const chunks = opts?.chunkSize
			? fixedChunks(bodyChunks(object.body), opts.chunkSize)
			: bodyChunks(object.body);
		return Readable.from(chunks, { objectMode: false });
	}

	async copy(sourceKey: string, targetKey: string): Promise<void> {
		const object = await this.bucket.get(r2KeyOf(sourceKey));
		if (!object) return;
		await this.bucket.put(r2KeyOf(targetKey), object.body, {
			httpMetadata: object.httpMetadata,
			customMetadata: object.customMetadata,
		});
	}

	async rename(oldKey: string, newKey: string): Promise<void> {
		if (oldKey === newKey) return;
		await this.copy(oldKey, newKey);
		await this.bucket.delete(r2KeyOf(oldKey));
	}

	async delete(keys: string[]): Promise<void> {
		if (keys.length > 0) await this.bucket.delete(keys.map(r2KeyOf));
	}

	async getMetadata(key: string): Promise<BlobMetadata | null> {
		const head = await this.bucket.head(r2KeyOf(key));
		if (!head) return null;
		return {
			fileName: head.customMetadata?.fileName,
			mimeType: head.httpMetadata?.contentType,
			fileSize: head.size,
		};
	}
}
