import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Instance, Session } from '../api/harness';
import { arrayOf, dataOf, recordOf, startInstance } from '../api/harness';
import { unsupportedNodes } from '../../src/generated/node-loaders';
import { LC } from './run';

const require = createRequire(import.meta.url);
const langchainDir = path.dirname(require.resolve('@n8n/n8n-nodes-langchain/package.json'));

interface Description {
	name: string;
	version: number | number[];
	inputs?: unknown;
	outputs?: unknown;
	properties: Array<{ name: string; default?: unknown }>;
}

/** Every name and version of the langchain package, from its build output. */
function langchainNodeInfos() {
	const descriptions = JSON.parse(
		readFileSync(path.join(langchainDir, 'dist/types/nodes.json'), 'utf8'),
	) as Description[];
	return descriptions.flatMap(({ name, version }) =>
		(Array.isArray(version) ? version : [version]).map((v) => ({
			name: `${LC}${name}`,
			version: v,
		})),
	);
}

/** Runs an `={{ ... }}` inputs or outputs expression with the node's default parameters. */
function evaluateConnections(
	expression: string,
	description: Description,
	version: number,
): unknown {
	const body = expression.replace(/^=\{\{/, '').replace(/\}\}$/, '');
	const parameters = Object.fromEntries(description.properties.map((p) => [p.name, p.default]));
	return new Function('$parameter', '$nodeVersion', `return (${body});`)(parameters, version);
}

describe('langchain node types', () => {
	let instance: Instance;
	let session: Session;
	beforeAll(async () => {
		instance = await startInstance();
		session = await instance.ownerSession();
	});
	afterAll(async () => {
		await instance?.dispose();
	});

	it('loads every supported node in the worker, with inputs and outputs that evaluate', async () => {
		const requested = langchainNodeInfos().filter(({ name }) => !(name in unsupportedNodes));
		const response = await session.post('/rest/node-types', { nodeInfos: requested });
		expect(response.status).toBe(200);
		const descriptions = arrayOf(dataOf(response)).map(
			(d) => recordOf(d) as unknown as Description,
		);

		// Like stock, a description keeps the short name. Failed nodes are left out of the list.
		const shortName = (name: string) => name.slice(LC.length);
		const served = descriptions.map(({ name }) => name);
		expect(served).toEqual(requested.map(({ name }) => shortName(name)));

		const failures: string[] = [];
		for (const [index, description] of descriptions.entries()) {
			for (const key of ['inputs', 'outputs'] as const) {
				const expression = description[key];
				if (typeof expression !== 'string') continue;
				try {
					const value = evaluateConnections(expression, description, requested[index].version);
					if (!Array.isArray(value)) failures.push(`${description.name} ${key}: not a list`);
				} catch (error) {
					failures.push(`${description.name} ${key}: ${String(error)}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it('does not serve a node type that does not work on Workers', async () => {
		const response = await session.post('/rest/node-types', {
			nodeInfos: [{ name: `${LC}vectorStoreMilvus`, version: 1 }],
		});
		expect(response.status).toBe(200);
		expect(dataOf(response)).toEqual([]);
	});
});
