import { Container } from '@n8n/di';
import {
	BinaryDataBlobManager,
	BinaryDataService,
	Cipher,
	EncryptionKeyProxy,
	ErrorReporter,
	InstanceSettings,
} from 'n8n-core';
import type { IEncryptionKeyProvider, KeyInfo } from 'n8n-core';
import { setExpressionEvaluator } from 'n8n-workflow';

import type { Env } from '../env';
import { applyNodeCompat } from './node-compat';
import { R2ByteStore } from './r2-byte-store';
import { SvalEvaluator } from './sval-evaluator';

/**
 * Stock n8n without key rotation writes ciphertext with no key-id prefix, encrypted with the
 * instance key. This provider gives Cipher exactly that key, so data stays portable.
 */
function legacyKeyProvider(cipher: Cipher): IEncryptionKeyProvider {
	let key: KeyInfo | undefined;
	const legacy = async () => {
		key ??= {
			id: 'legacy',
			value: cipher.encryptDEKWithInstanceKey(Container.get(InstanceSettings).encryptionKey),
			algorithm: 'aes-256-cbc',
			format: 'no-prefix',
		};
		return key;
	};
	return {
		getActiveKey: legacy,
		getLegacyKey: legacy,
		getKeyById: async (id) => (id === 'legacy' ? await legacy() : null),
	};
}

let initialized: Promise<void> | undefined;

async function initialize(env: Env): Promise<void> {
	if (!env.N8N_ENCRYPTION_KEY) throw new Error('The N8N_ENCRYPTION_KEY secret is not set');
	process.env.N8N_ENCRYPTION_KEY = env.N8N_ENCRYPTION_KEY;
	process.env.N8N_USER_FOLDER ??= '/tmp';
	// Binary data goes to R2 through the same manager stock n8n uses for S3.
	process.env.N8N_DEFAULT_BINARY_DATA_MODE = 's3';
	if (env.N8N_DEFAULT_TIMEZONE) process.env.GENERIC_TIMEZONE = env.N8N_DEFAULT_TIMEZONE;

	applyNodeCompat();
	setExpressionEvaluator(SvalEvaluator);
	Container.get(EncryptionKeyProxy).setProvider(legacyKeyProvider(Container.get(Cipher)));

	// InstanceSettings keeps the key. Remove it from process.env, which user code could reach.
	Container.get(InstanceSettings);
	delete process.env.N8N_ENCRYPTION_KEY;

	const binaryData = Container.get(BinaryDataService);
	binaryData.setManager(
		's3',
		new BinaryDataBlobManager(new R2ByteStore(env.STORAGE), Container.get(ErrorReporter)),
	);
	await binaryData.init();
}

/** Runs once per isolate, on the first request. Workers forbid I/O and randomness at startup. */
export async function bootstrap(env: Env): Promise<void> {
	initialized ??= initialize(env).catch((error: unknown) => {
		initialized = undefined;
		throw error;
	});
	await initialized;
}
