type Constructor<T> = new () => T;

/** Dynamic import of a CJS module exposes its exports under `default`. */
export function instantiate<T>(mod: Record<string, unknown>, className: string): T {
	const exported = (mod[className] ??
		(mod.default as Record<string, unknown> | undefined)?.[className]) as
		| Constructor<T>
		| undefined;
	if (typeof exported !== 'function') throw new Error(`Module does not export class ${className}`);
	return new exported();
}
