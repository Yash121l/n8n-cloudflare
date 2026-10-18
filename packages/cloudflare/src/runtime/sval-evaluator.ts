import type { ExpressionEvaluator, ReturnValue, Tournament } from '@n8n/tournament';
import Sval from 'sval';

type CompiledExpression = (this: unknown, errorHandler: (error: Error) => void) => ReturnValue;

/**
 * Runs Tournament-compiled expression code with the sval interpreter, because
 * Workers forbid `new Function`. The code string and calling convention are the
 * same as Tournament's FunctionEvaluator, so `this` is the real WorkflowDataProxy.
 */
export class SvalEvaluator implements ExpressionEvaluator {
	private readonly interpreter = new Sval({
		ecmaVer: 'latest',
		sourceType: 'script',
		sandBox: true,
	});

	private readonly cache = new Map<string, CompiledExpression>();

	constructor(private readonly instance: Tournament) {}

	evaluate(expr: string, data: unknown): ReturnValue {
		return this.compile(expr).call(data, this.instance.errorHandler);
	}

	private compile(expr: string): CompiledExpression {
		const cached = this.cache.get(expr);
		if (cached) return cached;

		const [code] = this.instance.getExpressionCode(expr);
		const key = `e${this.cache.size}`;
		this.interpreter.run(`exports.${key} = function (E) {\n${code};\n};`);
		const fn = (this.interpreter.exports as Record<string, CompiledExpression>)[key];
		this.cache.set(expr, fn);
		return fn;
	}
}
