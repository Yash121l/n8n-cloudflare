import type { INodeType, INodeTypeDescription } from 'n8n-workflow';
import { isHitlToolType } from 'n8n-workflow';

// The stock generators. They import only n8n-workflow, so the worker bundle can use them as they are.
import { convertNodeToAiTool, convertNodeToHitlTool } from '../../../../cli/src/tool-generation';

/** packages/cli/src/utils.ts `stripToolSuffix` */
export const stripToolSuffix = (type: string) => type.replace(/HitlTool$/, '').replace(/Tool$/, '');

/** packages/cli/src/utils.ts `satisfiesToolCapability` */
export const satisfiesToolCapability = (toolType: string, nodeType: INodeType) =>
	isHitlToolType(toolType) || Boolean(nodeType.description.usableAsTool);

/**
 * The tool node that stock `NodeTypes.getByNameAndVersion` makes from a base node version.
 * It extends the base node, so the base node stays as it is.
 */
export function createToolNode(toolType: string, base: INodeType): INodeType {
	const isHitlTool = isHitlToolType(toolType);
	const clonedProperties = Object.create(
		base.description.properties,
	) as INodeTypeDescription['properties'];
	const clonedDescription = Object.create(base.description, {
		properties: { value: clonedProperties, writable: isHitlTool },
	}) as INodeTypeDescription;
	const clonedNode = Object.create(base, {
		description: { value: clonedDescription },
	}) as INodeType;
	return isHitlTool ? convertNodeToHitlTool(clonedNode) : convertNodeToAiTool(clonedNode);
}
