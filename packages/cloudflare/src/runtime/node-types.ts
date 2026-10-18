import type { ExecuteContext } from 'n8n-core';
import { RoutingNode } from 'n8n-core';
import type {
	ICredentialType,
	ICredentialTypes,
	INodeType,
	INodeTypes,
	IVersionedNodeType,
	IWorkflowBase,
} from 'n8n-workflow';
import { NodeHelpers, UnexpectedError, UserError } from 'n8n-workflow';

import { credentialLoaders, credentialSupportedNodes } from '../generated/credential-loaders';
import { nodeLoaders, unsupportedNodes } from '../generated/node-loaders';
import { createToolNode, satisfiesToolCapability, stripToolSuffix } from './ai/tool-variants';

type NodeLoader = () => Promise<INodeType | IVersionedNodeType>;

/**
 * n8n looks node and credential types up synchronously, but on Workers each type is a lazily
 * imported module. So callers preload the types a workflow uses before they run it.
 */
const loadedNodes = new Map<string, INodeType | IVersionedNodeType>();
const loadedCredentials = new Map<string, ICredentialType>();
const toolNodes = new Map<string, INodeType>();

/** A full type name is `<package>.<node>`, like `@n8n/n8n-nodes-langchain.agent`. */
function loaderOf(type: string): NodeLoader | undefined {
	const dot = type.lastIndexOf('.');
	if (dot === -1) return undefined;
	const packageLoaders = Object.hasOwn(nodeLoaders, type.slice(0, dot))
		? nodeLoaders[type.slice(0, dot)]
		: undefined;
	const name = type.slice(dot + 1);
	return packageLoaders && Object.hasOwn(packageLoaders, name) ? packageLoaders[name] : undefined;
}

/**
 * Like stock `NodeTypes.resolveBaseName`: a `...Tool` or `...HitlTool` name that is not a real
 * node is a tool variant of its base node. Unsupported names are never tool variants.
 */
function resolveBaseName(type: string): { baseName: string; isSyntheticTool: boolean } {
	const isSyntheticTool =
		type.endsWith('Tool') && !loaderOf(type) && !Object.hasOwn(unsupportedNodes, type);
	return { baseName: isSyntheticTool ? stripToolSuffix(type) : type, isSyntheticTool };
}

export const isKnownNodeType = (type: string) =>
	loaderOf(resolveBaseName(type).baseName) !== undefined;

function assertSupported(type: string) {
	if (Object.hasOwn(unsupportedNodes, type)) {
		throw new UserError(
			`The node type ${type} is not supported on Cloudflare Workers: ${unsupportedNodes[type]}`,
		);
	}
}

/** Loads a node type. For a tool variant, loads the base node. */
export async function loadNodeType(type: string): Promise<INodeType | IVersionedNodeType> {
	const { baseName } = resolveBaseName(type);
	assertSupported(baseName);
	const cached = loadedNodes.get(baseName);
	if (cached) return cached;
	const loader = loaderOf(baseName);
	if (!loader) throw new UserError(`Unrecognized node type: ${type}`);
	const nodeType = await loader();
	loadedNodes.set(baseName, nodeType);
	return nodeType;
}

export async function loadCredentialType(name: string): Promise<ICredentialType> {
	const cached = loadedCredentials.get(name);
	if (cached) return cached;
	const loader = credentialLoaders[name];
	if (!loader) throw new UserError(`Unrecognized credential type: ${name}`);
	const credentialType = await loader();
	loadedCredentials.set(name, credentialType);
	await Promise.all((credentialType.extends ?? []).map(loadCredentialType));
	return credentialType;
}

/** Loads every node type, and every credential type those nodes can use, of a workflow. */
export async function preloadWorkflowTypes(workflow: Pick<IWorkflowBase, 'nodes'>): Promise<void> {
	// One at a time: a cold isolate hung when it imported several node modules in parallel.
	const types = new Set(workflow.nodes.map((node) => node.type));
	const nodeTypes: Array<INodeType | IVersionedNodeType> = [];
	for (const type of types) {
		if (isKnownNodeType(type)) nodeTypes.push(await loadNodeType(type));
	}

	const credentialNames = new Set<string>();
	for (const node of workflow.nodes) {
		for (const name of Object.keys(node.credentials ?? {})) credentialNames.add(name);
	}
	for (const nodeType of nodeTypes) {
		const versions = 'nodeVersions' in nodeType ? Object.values(nodeType.nodeVersions) : [nodeType];
		for (const version of versions) {
			for (const credential of version.description.credentials ?? []) {
				credentialNames.add(credential.name);
			}
		}
	}
	await Promise.all(
		[...credentialNames].filter((n) => n in credentialLoaders).map(loadCredentialType),
	);
}

/** packages/cli/src/utils.ts `shouldAssignExecuteMethod` */
const shouldAssignExecuteMethod = (nodeType: INodeType) => {
	const isDeclarativeNode = nodeType.description.requestDefaults !== undefined;
	return (
		!nodeType.execute &&
		!nodeType.supplyData &&
		!nodeType.poll &&
		!nodeType.trigger &&
		(!nodeType.webhook || isDeclarativeNode) &&
		(!nodeType.methods || isDeclarativeNode)
	);
};

/** Mirrors stock `NodeTypes` in packages/cli/src/node-types.ts. */
export const nodeTypes: INodeTypes = {
	getByName(type) {
		const nodeType = loadedNodes.get(resolveBaseName(type).baseName);
		if (!nodeType) throw new UnexpectedError(`Node type ${type} was not preloaded`);
		return nodeType;
	},
	getByNameAndVersion(type, version) {
		const { baseName, isSyntheticTool } = resolveBaseName(type);
		const versioned = NodeHelpers.getVersionedNodeType(this.getByName(baseName), version);
		if (isSyntheticTool && typeof versioned.supplyData === 'function') {
			throw new UnexpectedError('Node already has a `supplyData` method', {
				extra: { nodeType: baseName },
			});
		}
		if (shouldAssignExecuteMethod(versioned)) {
			versioned.execute = async function (this: ExecuteContext) {
				const routingNode = new RoutingNode(this, versioned);
				return (await routingNode.runNode()) ?? [];
			};
		}
		if (!isSyntheticTool) return versioned;

		// A base node can be a tool at several versions, so the key includes the version.
		const key = `${type}?version=${version ?? 'default'}`;
		const cached = toolNodes.get(key);
		if (cached) return cached;
		if (!satisfiesToolCapability(type, versioned)) {
			throw new UserError('Node cannot be used as a tool', { extra: { nodeType: baseName } });
		}
		const tool = createToolNode(type, versioned);
		toolNodes.set(key, tool);
		return tool;
	},
	getKnownTypes() {
		return {};
	},
};

export const credentialTypes: ICredentialTypes & {
	getSupportedNodes(type: string): string[];
	getParentTypes(type: string): string[];
} = {
	recognizes(type) {
		return type in credentialLoaders;
	},
	getByName(type) {
		const credentialType = loadedCredentials.get(type);
		if (!credentialType) throw new UnexpectedError(`Credential type ${type} was not preloaded`);
		return credentialType;
	},
	getSupportedNodes(type) {
		return credentialSupportedNodes[type] ?? [];
	},
	getParentTypes(type) {
		const parents = this.getByName(type).extends ?? [];
		return [...parents, ...parents.flatMap((parent) => this.getParentTypes(parent))];
	},
};
