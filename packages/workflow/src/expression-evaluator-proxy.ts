import { Tournament } from '@n8n/tournament';
import type { ExpressionEvaluatorClass } from '@n8n/tournament';

import { expressionSandboxHooks } from './expression-sandboxing';

type Evaluator = (expr: string, data: unknown) => string | null | (() => unknown);
type ErrorHandler = (error: Error) => void;

const errorHandler: ErrorHandler = () => {};
const tournamentEvaluator = new Tournament(
	errorHandler,
	undefined,
	undefined,
	expressionSandboxHooks,
);
const evaluator: Evaluator = tournamentEvaluator.execute.bind(tournamentEvaluator);

export const setErrorHandler = (handler: ErrorHandler) => {
	tournamentEvaluator.errorHandler = handler;
};

/**
 * Replace how compiled expression code runs. Runtimes that forbid `new Function`
 * (for example Cloudflare Workers) use this to plug in an interpreter.
 */
export const setExpressionEvaluator = (Evaluator: ExpressionEvaluatorClass) => {
	tournamentEvaluator.setEvaluator(Evaluator);
};

export const evaluateExpression: Evaluator = (expr, data) => {
	return evaluator(expr, data);
};
