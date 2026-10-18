import { Credentials, getAdditionalKeys } from 'n8n-core';
import type {
	ICredentialDataDecryptedObject,
	ICredentialsExpressionResolveValues,
	IExecuteData,
	IHttpRequestHelper,
	IHttpRequestOptions,
	INode,
	INodeCredentialsDetails,
	INodeParameters,
	INodeProperties,
	INodeType,
	INodeTypes,
	IRequestOptionsSimplified,
	IWorkflowDataProxyAdditionalKeys,
	IWorkflowExecuteAdditionalData,
	WorkflowExecuteMode,
} from 'n8n-workflow';
import {
	ICredentialsHelper,
	NodeHelpers,
	UnexpectedError,
	UserError,
	Workflow,
	isExpression,
} from 'n8n-workflow';

import type { CredentialRow } from '../db/types';
import { findCredentialsUnusableByWorkflow } from './credential-access';
import { credentialTypes, loadCredentialType } from './node-types';

/** Fields the OAuth flow owns. They must never come from user input or defaults. */
const OAUTH_PINNED_FIELDS = ['oauthTokenData'];

const mockNode: INode = {
	id: 'mock',
	name: '',
	typeVersion: 1,
	type: 'mock',
	position: [0, 0],
	parameters: {},
};

const mockNodeType: INodeType = {
	description: {
		displayName: 'Mock',
		name: 'mock',
		group: [],
		version: 1,
		description: '',
		defaults: {},
		inputs: [],
		outputs: [],
		properties: [],
	},
};

const mockNodeTypes: INodeTypes = {
	getByName: () => mockNodeType,
	getByNameAndVersion: () => mockNodeType,
	getKnownTypes: () => ({}),
};

/** Port of packages/cli/src/credentials-helper.ts that reads credentials from D1. */
export class CredentialsHelper extends ICredentialsHelper {
	constructor(private readonly db: D1Database) {
		super();
	}

	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		typeName: string,
		requestOptions: IHttpRequestOptions | IRequestOptionsSimplified,
		workflow?: Workflow,
		node?: INode,
	): Promise<IHttpRequestOptions> {
		const credentialType = await loadCredentialType(typeName);
		const { authenticate } = credentialType;
		if (typeof authenticate === 'function') {
			return await authenticate(credentials, requestOptions as IHttpRequestOptions);
		}
		if (typeof authenticate === 'object') {
			if (!workflow || !node) {
				throw new UnexpectedError(
					'Workflow and node are required for declarative credential authentication',
				);
			}
			requestOptions.headers ??= {};
			if (authenticate.type === 'generic') {
				const target = requestOptions as unknown as Record<string, Record<string, string>>;
				for (const [outerKey, outerValue] of Object.entries(authenticate.properties)) {
					for (const [key, value] of Object.entries(outerValue as Record<string, string>)) {
						const keyResolved = this.resolveValue(
							key,
							{ $credentials: credentials },
							workflow,
							node,
						);
						const valueResolved = this.resolveValue(
							value,
							{ $credentials: credentials },
							workflow,
							node,
						);
						target[outerKey] ??= {};
						target[outerKey][keyResolved] = valueResolved;
					}
				}
			}
		}
		return requestOptions as IHttpRequestOptions;
	}

	async preAuthentication(
		helpers: IHttpRequestHelper,
		credentials: ICredentialDataDecryptedObject,
		typeName: string,
		node: INode,
		credentialsExpired: boolean,
	): Promise<ICredentialDataDecryptedObject | undefined> {
		const credentialType = await loadCredentialType(typeName);
		const expirableProperty = credentialType.properties.find(
			(property) => property.type === 'hidden' && property.typeOptions?.expirable === true,
		);
		if (expirableProperty?.name === undefined) return undefined;
		if (typeof credentialType.preAuthentication !== 'function') return undefined;

		const isTestingCredentials =
			node?.parameters?.temp === '' && node?.type === 'n8n-nodes-base.noOp';
		if (
			credentials[expirableProperty.name] !== '' &&
			!credentialsExpired &&
			!isTestingCredentials
		) {
			return undefined;
		}

		const output = await credentialType.preAuthentication.call(helpers, credentials);
		if (output[expirableProperty.name] === undefined) return undefined;

		if (node.credentials) {
			const nodeCredentials = node.credentials[credentialType.name];
			const storedData = await (
				await this.getCredentials(nodeCredentials, credentialType.name)
			).getData();
			const dataToPersist: ICredentialDataDecryptedObject = { ...storedData };
			for (const [key, value] of Object.entries(output as ICredentialDataDecryptedObject)) {
				// Keep fields the user stored as expressions, so later runs resolve them again.
				if (key === expirableProperty.name || !isExpression(storedData[key])) {
					dataToPersist[key] = value;
				}
			}
			await this.updateCredentials(nodeCredentials, credentialType.name, dataToPersist);
			return Object.assign(credentials, output as ICredentialDataDecryptedObject);
		}
		return undefined;
	}

	async runPreAuthentication(
		helpers: IHttpRequestHelper,
		credentials: ICredentialDataDecryptedObject,
		typeName: string,
	): Promise<ICredentialDataDecryptedObject | undefined> {
		const credentialType = await loadCredentialType(typeName);
		if (typeof credentialType.preAuthentication !== 'function') return undefined;
		return (
			((await credentialType.preAuthentication.call(
				helpers,
				credentials,
			)) as ICredentialDataDecryptedObject) ?? undefined
		);
	}

	private resolveValue(
		parameterValue: string,
		additionalKeys: IWorkflowDataProxyAdditionalKeys,
		workflow: Workflow,
		node: INode,
	): string {
		if (!isExpression(parameterValue)) return parameterValue;
		const value = workflow.expression.getSimpleParameterValue(
			node,
			parameterValue,
			'internal',
			additionalKeys,
			undefined,
			'',
		);
		return value ? String(value) : '';
	}

	getParentTypes(typeName: string): string[] {
		return credentialTypes.getParentTypes(typeName);
	}

	isCredentialUsableByNode(credentialType: string, nodeType: string): boolean {
		if (!credentialTypes.recognizes(credentialType)) return true;
		const typeDef = credentialTypes.getByName(credentialType);
		if (!typeDef.restrictToSupportedNodes) return true;
		return credentialTypes.getSupportedNodes(credentialType).includes(nodeType);
	}

	async getCredentials(
		nodeCredential: INodeCredentialsDetails,
		type: string,
	): Promise<Credentials> {
		const row = await this.getCredentialsRow(nodeCredential, type);
		return new Credentials({ id: row.id, name: row.name }, row.type, row.data);
	}

	private async getCredentialsRow(
		nodeCredential: INodeCredentialsDetails,
		type: string,
	): Promise<CredentialRow> {
		if (!nodeCredential.id) {
			throw new UserError(`Credential "${nodeCredential.name}" of type "${type}" has no ID.`);
		}
		const row = await this.db
			.prepare('SELECT * FROM credentials_entity WHERE id = ? AND type = ?')
			.bind(nodeCredential.id, type)
			.first<CredentialRow>();
		if (!row) {
			throw new UserError(
				`Credential with ID "${nodeCredential.id}" does not exist for type "${type}".`,
			);
		}
		return row;
	}

	getCredentialsProperties(type: string): INodeProperties[] {
		return CredentialsHelper.credentialsProperties(type);
	}

	/** The credential type has to be preloaded. */
	static credentialsProperties(type: string): INodeProperties[] {
		const credentialTypeData = credentialTypes.getByName(type);
		if (credentialTypeData.extends === undefined) {
			if (['oAuth1Api', 'oAuth2Api'].includes(type)) {
				return [
					...credentialTypeData.properties,
					{
						displayName: 'oauthTokenData',
						name: 'oauthTokenData',
						type: 'json',
						required: false,
						default: {},
					},
				];
			}
			return credentialTypeData.properties;
		}
		const combined: INodeProperties[] = [];
		for (const parent of credentialTypeData.extends) {
			NodeHelpers.mergeNodeProperties(combined, CredentialsHelper.credentialsProperties(parent));
		}
		NodeHelpers.mergeNodeProperties(combined, credentialTypeData.properties);
		return combined;
	}

	async getDecrypted(
		additionalData: IWorkflowExecuteAdditionalData,
		nodeCredentials: INodeCredentialsDetails,
		type: string,
		mode: WorkflowExecuteMode,
		executeData?: IExecuteData,
		raw?: boolean,
		expressionResolveValues?: ICredentialsExpressionResolveValues,
	): Promise<ICredentialDataDecryptedObject> {
		await loadCredentialType(type);
		await this.assertWorkflowMayUse(additionalData, nodeCredentials, type);
		const credentials = await this.getCredentials(nodeCredentials, type);
		const decryptedDataOriginal = await credentials.getData();
		if (raw === true) return decryptedDataOriginal;
		return await this.applyDefaultsAndOverwrites(
			additionalData,
			decryptedDataOriginal,
			type,
			mode,
			executeData,
			expressionResolveValues,
		);
	}

	/** Executions only use credentials that are shared with the project of their workflow. */
	private async assertWorkflowMayUse(
		{ workflowId, projectId }: IWorkflowExecuteAdditionalData,
		nodeCredential: INodeCredentialsDetails,
		type: string,
	): Promise<void> {
		if (!nodeCredential.id || (!workflowId && !projectId)) return;
		const { homeProject, inaccessibleIds } = await findCredentialsUnusableByWorkflow(
			this.db,
			{ workflowId, projectId },
			[nodeCredential.id],
		);
		// A run of a workflow that is not stored has no project to check against.
		if (homeProject && inaccessibleIds.length > 0) {
			throw new UserError(
				`Credential "${nodeCredential.name}" of type "${type}" is not shared with the project of this workflow.`,
			);
		}
	}

	async applyDefaultsAndOverwrites(
		additionalData: IWorkflowExecuteAdditionalData,
		decryptedDataOriginal: ICredentialDataDecryptedObject,
		type: string,
		mode: WorkflowExecuteMode,
		executeData?: IExecuteData,
		expressionResolveValues?: ICredentialsExpressionResolveValues,
	): Promise<ICredentialDataDecryptedObject> {
		await loadCredentialType(type);
		const credentialsProperties = this.getCredentialsProperties(type);

		const storedData = { ...decryptedDataOriginal };
		for (const field of OAUTH_PINNED_FIELDS) {
			if (credentialsProperties.some((p) => p.name === field && p.type === 'hidden')) {
				delete storedData[field];
			}
		}

		let decryptedData = NodeHelpers.getNodeParameters(
			credentialsProperties,
			storedData as INodeParameters,
			true,
			false,
			null,
			null,
		) as ICredentialDataDecryptedObject;

		if (decryptedDataOriginal.oauthTokenData !== undefined) {
			decryptedData.oauthTokenData = decryptedDataOriginal.oauthTokenData;
		}
		for (const key of ['allowedHttpRequestDomains', 'allowedDomains']) {
			if (decryptedData[key] === undefined && decryptedDataOriginal[key] !== undefined) {
				decryptedData[key] = decryptedDataOriginal[key];
			}
		}

		const additionalKeys = getAdditionalKeys(additionalData, mode, null, { isCredential: true });

		if (expressionResolveValues) {
			try {
				decryptedData = expressionResolveValues.workflow.expression.getParameterValue(
					decryptedData as INodeParameters,
					expressionResolveValues.runExecutionData,
					expressionResolveValues.runIndex,
					expressionResolveValues.itemIndex,
					expressionResolveValues.node.name,
					expressionResolveValues.connectionInputData,
					mode,
					additionalKeys,
					executeData,
					false,
					decryptedData,
				) as ICredentialDataDecryptedObject;
			} catch (e) {
				if (e instanceof Error) e.message += ' [Error resolving credentials]';
				throw e;
			}
		} else {
			const workflow = new Workflow({
				nodes: [mockNode],
				connections: {},
				active: false,
				nodeTypes: mockNodeTypes,
			});
			decryptedData = workflow.expression.getComplexParameterValue(
				mockNode,
				decryptedData as INodeParameters,
				mode,
				additionalKeys,
				undefined,
				undefined,
				decryptedData,
			) as ICredentialDataDecryptedObject;
		}
		return decryptedData;
	}

	async updateCredentials(
		nodeCredentials: INodeCredentialsDetails,
		type: string,
		data: ICredentialDataDecryptedObject,
	): Promise<void> {
		const credentials = await this.getCredentials(nodeCredentials, type);
		await credentials.setData(data);
		await this.db
			.prepare('UPDATE credentials_entity SET data = ?, updatedAt = ? WHERE id = ? AND type = ?')
			.bind(credentials.getDataToSave().data, new Date().toISOString(), credentials.id, type)
			.run();
	}

	async updateCredentialsOauthTokenData(
		nodeCredentials: INodeCredentialsDetails,
		type: string,
		data: ICredentialDataDecryptedObject,
	): Promise<void> {
		const credentials = await this.getCredentials(nodeCredentials, type);
		await credentials.updateData({ oauthTokenData: data.oauthTokenData });
		await this.db
			.prepare('UPDATE credentials_entity SET data = ?, updatedAt = ? WHERE id = ? AND type = ?')
			.bind(credentials.getDataToSave().data, new Date().toISOString(), credentials.id, type)
			.run();
	}
}
