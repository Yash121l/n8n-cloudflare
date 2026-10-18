// Stock n8n excludes these at startup (load-nodes-and-credentials.ts and the nodes.exclude default).
export const STOCK_EXCLUDED_NODES = [
	'n8n-nodes-base.executeCommand',
	'n8n-nodes-base.localFileTrigger',
	'n8n-nodes-base.e2eTest',
	'n8n-nodes-base.dynamicCredentialCheck',
];

/**
 * Node types that cannot run on Cloudflare Workers, with the reason. The editor does not list
 * them, and the runtime refuses to load them. Their `...Tool` and `...HitlTool` variants go too.
 */
export const UNSUPPORTED_ON_WORKERS_NODES = {
	'@n8n/n8n-nodes-langchain.code':
		'runs user code in vm2. Use the Code Tool or the Code node, which run on the Workers code runner',
	'@n8n/n8n-nodes-langchain.vectorStoreMilvus':
		'the Milvus SDK compiles protobuf code with new Function, which Workers do not allow',
	'@n8n/n8n-nodes-langchain.vectorStoreWeaviate': 'the Weaviate client needs gRPC over HTTP/2, which Workers do not have',
	'@n8n/n8n-nodes-langchain.mcpTrigger':
		'keeps MCP sessions and SSE responses in process memory across requests, which a Worker isolate cannot do',
};

/** Every name the editor must not list: the excluded nodes and the tool variants made from them. */
export const EXCLUDED_NODE_NAMES = [...STOCK_EXCLUDED_NODES, ...Object.keys(UNSUPPORTED_ON_WORKERS_NODES)].flatMap(
	(name) => [name, `${name}Tool`, `${name}HitlTool`],
);
