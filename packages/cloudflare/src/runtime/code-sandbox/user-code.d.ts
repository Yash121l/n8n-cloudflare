declare module 'n8n-code.cjs' {
	/** Runs the Code node source. The host wraps it, see `userCodeModule` in host.ts. */
	const run: (require: (name: string) => never, module: { exports: object }) => Promise<unknown>;
	export default run;
}
