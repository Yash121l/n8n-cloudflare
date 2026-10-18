import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(new URL('../../../cli/package.json', import.meta.url));
const handlebars = require('handlebars');
const templates = new URL('../../../cli/templates/', import.meta.url);
const views = readdirSync(templates).filter(
	(name) => name.endsWith('.handlebars') && /^(form-|send-and-wait)/.test(name),
);
const partials = readdirSync(new URL('partials/', templates)).filter((name) =>
	name.endsWith('.handlebars'),
);
const compile = (url) => handlebars.precompile(readFileSync(url, 'utf8'));
const source = `import H from ${JSON.stringify(require.resolve('handlebars/runtime'))};
H.registerHelper('eq', (a, b) => a === b);
H.registerHelper('includes', (a, b) => Array.isArray(a) ? a.includes(b) : typeof a === 'string' && typeof b === 'string' && a.split(',').map(s => s.trim()).includes(b));
${partials.map((name) => `H.registerPartial(${JSON.stringify(name.replace('.handlebars', ''))}, H.template(${compile(new URL('partials/' + name, templates))}));`).join('\n')}
const views = {${views.map((name) => `${JSON.stringify(name.replace('.handlebars', ''))}: H.template(${compile(new URL(name, templates))})`).join(',\n')}};
export function renderTemplate(view, data) { if (!views[view]) throw new Error('Unknown form template: ' + view); return views[view](data); }
`;
await build({
	stdin: { contents: source, resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	minify: true,
	outfile: fileURLToPath(new URL('templates.js', import.meta.url)),
});
writeFileSync(
	new URL('templates.d.ts', import.meta.url),
	'export function renderTemplate(view: string, data: Record<string, unknown>): string;\n',
);
