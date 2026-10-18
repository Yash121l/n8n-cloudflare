import {
	PaginationDto,
	UpdateWorkflowHistoryVersionDto,
	WorkflowHistoryVersionsByIdsDto,
	WorkflowPublishTimelineQueryDto,
} from '@n8n/api-types';
import { Hono } from 'hono';

import { requireUser } from '../../auth/middleware';
import {
	findHistoryVersion,
	historyVersionsByIds,
	listHistory,
	publishTimeline,
	updateHistoryVersion,
} from '../../db/workflow-history';
import type { AppEnv } from '../app';
import { ok } from '../app';
import { notFound } from '../errors';
import { parseDto, queryParams, readJson } from '../http';
import { requireWorkflow } from '../workflow-view';

export const workflowHistoryRoutes = new Hono<AppEnv>();

const DEFAULT_TAKE = 20;

workflowHistoryRoutes.get('/workflow-history/workflow/:workflowId', async (c) => {
	const user = requireUser(c);
	const workflowId = c.req.param('workflowId');
	await requireWorkflow(c.env.DB, user, workflowId, 'workflow:read').catch(() => {
		throw notFound('Could not find workflow');
	});
	const query = parseDto(PaginationDto, queryParams(c));
	return ok(
		c,
		await listHistory(c.env.DB, workflowId, query.take ?? DEFAULT_TAKE, query.skip ?? 0),
	);
});

workflowHistoryRoutes.get(
	'/workflow-history/workflow/:workflowId/version/:versionId',
	async (c) => {
		const user = requireUser(c);
		const workflowId = c.req.param('workflowId');
		await requireWorkflow(c.env.DB, user, workflowId, 'workflow:read').catch(() => {
			throw notFound('Could not find workflow');
		});
		const version = await findHistoryVersion(c.env.DB, workflowId, c.req.param('versionId'));
		if (!version) throw notFound('Could not find version');
		return ok(c, version);
	},
);

workflowHistoryRoutes.post('/workflow-history/workflow/:workflowId/versions', async (c) => {
	const user = requireUser(c);
	const workflowId = c.req.param('workflowId');
	await requireWorkflow(c.env.DB, user, workflowId, 'workflow:read').catch(() => {
		throw notFound('Could not find workflow');
	});
	const { versionIds } = parseDto(WorkflowHistoryVersionsByIdsDto, await readJson(c));
	return ok(c, { versions: await historyVersionsByIds(c.env.DB, workflowId, versionIds) });
});

workflowHistoryRoutes.get('/workflow-history/workflow/:workflowId/publish-timeline', async (c) => {
	const user = requireUser(c);
	const workflowId = c.req.param('workflowId');
	await requireWorkflow(c.env.DB, user, workflowId, 'workflow:read').catch(() => {
		throw notFound('Could not find workflow');
	});
	const query = parseDto(WorkflowPublishTimelineQueryDto, queryParams(c));
	return ok(c, await publishTimeline(c.env.DB, workflowId, query.skip, query.take));
});

workflowHistoryRoutes.patch(
	'/workflow-history/workflow/:workflowId/versions/:versionId',
	async (c) => {
		const user = requireUser(c);
		const workflowId = c.req.param('workflowId');
		const versionId = c.req.param('versionId');
		await requireWorkflow(c.env.DB, user, workflowId, 'workflow:update').catch(() => {
			throw notFound('Could not find workflow');
		});
		if (!(await findHistoryVersion(c.env.DB, workflowId, versionId)))
			throw notFound('Could not find version');
		const { name, description } = parseDto(UpdateWorkflowHistoryVersionDto, await readJson(c));
		await updateHistoryVersion(c.env.DB, workflowId, versionId, { name, description });
		return ok(c, undefined);
	},
);
