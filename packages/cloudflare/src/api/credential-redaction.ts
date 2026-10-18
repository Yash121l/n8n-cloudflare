/** Port of `redact` and `unredact` from stock `credentials.service.ts`. */
import {
	CREDENTIAL_BLANKING_VALUE,
	CREDENTIAL_EMPTY_VALUE,
	deepCopy,
	isINodePropertyCollection,
	jsonParse,
	jsonStringify,
} from 'n8n-workflow';
import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	INodeProperties,
	INodePropertyCollection,
} from 'n8n-workflow';

import { isRecord } from './http';

/** Sentinel placed at every leaf of a redacted JSON value, see `typeOptions.redactJsonLeaves`. */
const JSON_LEAF_REDACTED = '***';

const isDataObject = (value: unknown): value is IDataObject => isRecord(value);

const blank = (value: unknown) =>
	String(value ?? '').length > 0 ? CREDENTIAL_BLANKING_VALUE : CREDENTIAL_EMPTY_VALUE;

function redactJsonLeaves(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactJsonLeaves);
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactJsonLeaves(v)]));
	}
	// Expressions are references to secrets, not secrets, so they stay visible.
	if (typeof value === 'string' && value.startsWith('={{')) return value;
	return JSON_LEAF_REDACTED;
}

function redactCollection(data: IDataObject, option: INodePropertyCollection): void {
	const values = data[option.name];
	if (Array.isArray(values)) {
		for (const item of values) {
			if (isDataObject(item)) redactValues(item, option.values);
		}
	} else if (isDataObject(values)) {
		redactValues(values, option.values);
	}
}

function redactValues(data: IDataObject, props: INodeProperties[]): void {
	for (const key of Object.keys(data)) {
		if (key === 'oauthTokenData' || key === 'csrfSecret') {
			data[key] = blank(data[key]);
			continue;
		}

		const prop = props.find((p) => p.name === key);
		if (!prop) continue;

		if (prop.type === 'fixedCollection' && prop.options?.length) {
			const target = data[key];
			if (isDataObject(target)) {
				for (const option of prop.options) {
					if (isINodePropertyCollection(option)) redactCollection(target, option);
				}
			}
		}

		if (
			prop.typeOptions?.password &&
			(!String(data[key] ?? '').startsWith('={{') || prop.noDataExpression)
		) {
			data[key] = blank(data[key]);
			continue;
		}

		if (prop.typeOptions?.redactJsonLeaves) {
			const raw = String(data[key] ?? '');
			if (!raw) {
				data[key] = CREDENTIAL_EMPTY_VALUE;
			} else {
				try {
					data[key] = JSON.stringify(redactJsonLeaves(jsonParse<unknown>(raw)), null, 2);
				} catch {
					// Not valid JSON, for example an expression. Leave it as it is.
				}
			}
		}
	}
}

/** Replaces password fields and OAuth data with a sentinel the editor understands. */
export function redactCredentialData(
	data: ICredentialDataDecryptedObject,
	props: INodeProperties[],
): ICredentialDataDecryptedObject {
	const copy = deepCopy(data);
	redactValues(copy, props);
	return copy;
}

function restoreSentinels(unmerged: object, replacement: object): void {
	for (const [key, value] of Object.entries(unmerged)) {
		// A redacted field switched to expression mode gets a leading "=" in front of the sentinel.
		const sentinel = typeof value === 'string' && value.startsWith('=') ? value.slice(1) : value;
		const saved: unknown = Reflect.get(replacement, key);
		if (sentinel === CREDENTIAL_BLANKING_VALUE || sentinel === CREDENTIAL_EMPTY_VALUE) {
			Reflect.set(unmerged, key, saved);
		} else if (
			typeof value === 'object' &&
			value !== null &&
			typeof saved === 'object' &&
			saved !== null
		) {
			// Arrays recurse by index, like stock does, because collections such as headers are arrays.
			restoreSentinels(value, saved);
		}
	}
}

function mergeRedactedLeaves(incoming: unknown, saved: unknown): unknown {
	if (incoming === JSON_LEAF_REDACTED) return saved;
	if (Array.isArray(incoming) && Array.isArray(saved)) {
		return incoming.map((item, i) => mergeRedactedLeaves(item, saved[i]));
	}
	if (Array.isArray(incoming) || Array.isArray(saved)) return incoming;
	if (isRecord(incoming) && isRecord(saved)) {
		return Object.fromEntries(
			Object.entries(incoming).map(([k, v]) => [k, mergeRedactedLeaves(v, saved[k])]),
		);
	}
	return incoming;
}

/** Merges redacted data from the editor with the stored data into data that is ready to save. */
export function unredactCredentialData(
	redacted: ICredentialDataDecryptedObject,
	saved: ICredentialDataDecryptedObject,
	props: INodeProperties[],
): ICredentialDataDecryptedObject {
	const merged = deepCopy(redacted);
	restoreSentinels(merged, saved);

	for (const prop of props) {
		if (!prop.typeOptions?.redactJsonLeaves) continue;
		if (!(prop.name in merged) || !(prop.name in saved)) continue;
		try {
			const incoming = jsonParse<unknown>(String(merged[prop.name]));
			const stored = jsonParse<unknown>(String(saved[prop.name]));
			merged[prop.name] = jsonStringify(mergeRedactedLeaves(incoming, stored));
		} catch {
			// Not valid JSON. Leave it as it is.
		}
	}
	return merged;
}
