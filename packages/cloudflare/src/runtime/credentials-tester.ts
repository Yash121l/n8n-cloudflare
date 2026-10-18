import { CredentialTestContext, ExecuteContext, RoutingNode } from 'n8n-core';
import type {
	ICredentialTestFunction,
	ICredentialTestRequestData,
	ICredentialsDecrypted,
	ICredentialsHelper,
	INode,
	INodeCredentialTestResult,
	INodeType,
	INodeTypes,
	IWorkflowExecuteAdditionalData,
} from 'n8n-workflow';
import {
	NodeHelpers,
	VersionedNodeType,
	Workflow,
	createEmptyRunExecutionData,
} from 'n8n-workflow';

import { credentialTypes, loadNodeType } from './node-types';

const OAUTH2_OK = 'Connection Successful!';
const OAUTH2_FAILED = 'This OAuth2 credential was not connected to an account.';

const getPath = (value: unknown, path: string): unknown =>
	path
		.split('.')
		.reduce<unknown>(
			(acc, key) =>
				acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
			value,
		);

/** Port of CredentialsTester.getCredentialTestFunction (packages/cli/src/services). */
async function getCredentialTestFunction(
	credentialType: string,
): Promise<ICredentialTestFunction | ICredentialTestRequestData | undefined> {
	const type = credentialTypes.getByName(credentialType);
	if (type.test) return { testRequest: type.test };

	for (const nodeName of credentialTypes.getSupportedNodes(credentialType)) {
		let node;
		try {
			node = await loadNodeType(nodeName);
		} catch {
			continue;
		}
		const allNodeTypes: INodeType[] =
			node instanceof VersionedNodeType ? Object.values(node.nodeVersions) : [node as INodeType];

		for (const nodeType of allNodeTypes) {
			for (const { name, testedBy } of nodeType.description.credentials ?? []) {
				if (name !== credentialType) continue;
				if (credentialTypes.getParentTypes(name).includes('oAuth2Api') || name === 'oAuth2Api') {
					return async function oauth2CredTest(
						cred: ICredentialsDecrypted,
					): Promise<INodeCredentialTestResult> {
						const tokenData = cred.data?.oauthTokenData;
						const hasToken =
							typeof tokenData === 'object' && tokenData !== null && 'access_token' in tokenData;
						return hasToken
							? { status: 'OK', message: OAUTH2_OK }
							: { status: 'Error', message: OAUTH2_FAILED };
					};
				}
				if (!testedBy) continue;
				if (typeof testedBy === 'string') {
					if (node instanceof VersionedNodeType) {
						const versions = Object.keys(node.nodeVersions).sort().reverse();
						for (const version of versions) {
							const credentialTest = node.nodeVersions[Number(version)].methods?.credentialTest;
							if (credentialTest && testedBy in credentialTest) return credentialTest[testedBy];
						}
					}
					return (node as INodeType).methods?.credentialTest?.[testedBy];
				}
				return { nodeType, testRequest: testedBy };
			}
		}
	}
	return undefined;
}

async function runRequestTest(
	credentialType: string,
	credentials: ICredentialsDecrypted,
	testFunction: ICredentialTestRequestData,
	baseAdditionalData: IWorkflowExecuteAdditionalData,
): Promise<INodeCredentialTestResult> {
	const nodeType =
		testFunction.nodeType ??
		NodeHelpers.getVersionedNodeType(await loadNodeType('n8n-nodes-base.noOp'));
	const version = nodeType.description.version;
	const node: INode = {
		id: 'temp',
		parameters: {},
		name: 'Temp-Node',
		type: nodeType.description.name,
		typeVersion: Array.isArray(version) ? version[version.length - 1] : version,
		position: [0, 0],
		credentials: { [credentialType]: { id: credentials.id, name: credentials.name } },
	};
	const nodeTypeCopy: INodeType = {
		description: {
			...nodeType.description,
			credentials: [{ name: credentialType, required: true }],
			properties: [
				{
					displayName: 'Temp',
					name: 'temp',
					type: 'string',
					routing: { request: testFunction.testRequest.request },
					default: '',
				},
			],
		},
	};
	const mockNodeTypes: INodeTypes = {
		getByName: () => nodeTypeCopy,
		getByNameAndVersion: () => nodeTypeCopy,
		getKnownTypes: () => ({}),
	};
	const workflow = new Workflow({
		nodes: [node],
		connections: {},
		active: false,
		nodeTypes: mockNodeTypes,
	});

	// The routing node reads credentials through the helper; give it the unsaved form values.
	const stored = baseAdditionalData.credentialsHelper;
	const getDecrypted: ICredentialsHelper['getDecrypted'] = async (
		data,
		nodeCredentials,
		type,
		mode,
		executeData,
		raw,
		...rest
	) =>
		raw
			? await stored.getDecrypted(data, nodeCredentials, type, mode, executeData, raw, ...rest)
			: (credentials.data ?? {});
	const additionalData: IWorkflowExecuteAdditionalData = {
		...baseAdditionalData,
		currentNodeParameters: node.parameters,
		credentialsHelper: new Proxy(stored, {
			get(target, prop) {
				if (prop === 'getDecrypted') return getDecrypted;
				const value: unknown = Reflect.get(target, prop);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}),
	};

	const executeFunctions = new ExecuteContext(
		workflow,
		node,
		additionalData,
		'internal',
		createEmptyRunExecutionData(),
		0,
		[],
		{ main: [[{ json: {} }]] },
		{ node, data: {}, source: null },
		[],
	);
	const routingNode = new RoutingNode(executeFunctions, nodeTypeCopy, credentials);

	let response;
	try {
		response = await routingNode.runNode();
	} catch (e) {
		const error = e as {
			message?: string;
			cause?: { response?: { status: number; statusText?: string }; code?: string };
		};
		if (error.cause?.response) {
			const { status, statusText } = error.cause.response;
			for (const rule of testFunction.testRequest.rules ?? []) {
				if (rule.type === 'responseCode' && status === rule.properties.value) {
					return { status: 'Error', message: rule.properties.message };
				}
			}
			if (status < 199 || status > 299) {
				return { status: 'Error', message: statusText || `Received HTTP status code: ${status}` };
			}
		} else if (error.cause?.code) {
			return { status: 'Error', message: error.cause.code };
		}
		return { status: 'Error', message: String(error.message) };
	}

	for (const rule of testFunction.testRequest.rules ?? []) {
		if (rule.type === 'responseSuccessBody') {
			const responseData = response?.[0]?.[0]?.json;
			if (getPath(responseData, rule.properties.key) === rule.properties.value) {
				return { status: 'Error', message: rule.properties.message };
			}
		}
	}
	return { status: 'OK', message: 'Connection successful!' };
}

export async function testCredentialsWith(
	credentials: ICredentialsDecrypted,
	baseAdditionalData: IWorkflowExecuteAdditionalData,
	applyDefaults: (
		data: NonNullable<ICredentialsDecrypted['data']>,
	) => Promise<NonNullable<ICredentialsDecrypted['data']>>,
): Promise<INodeCredentialTestResult> {
	const testFunction = await getCredentialTestFunction(credentials.type);
	if (testFunction === undefined) {
		return { status: 'Error', message: 'No testing function found for this credential.' };
	}
	try {
		if (credentials.data) credentials.data = await applyDefaults(credentials.data);
	} catch (error) {
		return { status: 'Error', message: error instanceof Error ? error.message : String(error) };
	}
	if (typeof testFunction === 'function') {
		return await testFunction.call(new CredentialTestContext(baseAdditionalData), credentials);
	}
	return await runRequestTest(credentials.type, credentials, testFunction, baseAdditionalData);
}
