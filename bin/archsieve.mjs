#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { scan, scanRef } from '../src/scan.mjs';
import { diff, toMarkdown } from '../src/diff.mjs';
import { buildDiagram, toMarkdownView, toMermaid, toDot } from '../src/render.mjs';
import { validate } from '../src/validate.mjs';
import { DEFAULT_TEST_GLOBS } from '../src/tests.mjs';
import { affected } from '../src/affected.mjs';

const USAGE = `archsieve: architecture evidence for coding agents (V0, experimental)

Usage:
  archsieve scan <dir> [--ref <git-ref>] [-o snapshot.json] [--paths a,b] [--exclude <regex, added to defaults>] [--ts-config <file>]
                       [--test-globs <glob,...>] [--history [--since <N>d|<date> (default 90d)] [--co-change-min N (default 5)]]
                       [--no-js] [--no-units] [--model <likec4.json>] [--go auto|none|<dir,...>] [--nest-entry <compiled module.js> [--nest-export AppModule]]
  archsieve diff <before.json> <after.json> [--format json|md] [--depth N] [-o file] [--fail-on error|signal|none] [--no-tests]
  archsieve render <snapshot.json> [--view components|files|nest|containers] [--depth N] [--format mermaid|dot|md]
                       [--compare <before.json>] [--externals] [--within <dir>] [--focus <id>] [--no-tests]
                       [--max-nodes N (default 40)] [--max-edges N (default 100)] [-o file]
  archsieve affected <snapshot.json> (--changed <file> ... | --base <git-ref> [--repo <dir>]) [--ignore <glob,...>] [-o file]
  archsieve validate <snapshot-or-diff-or-affected.json>

render: --format md adds title, concern, scope line and legend. --within zooms into a folder (outside neighbours become
dashed boundary boxes); --focus shows one element with its direct dependencies and dependents. Over budget, components
reduce --depth; files and nest exit 2. 0 disables a budget.

--ts-config <file> resolves tsconfig path aliases; --ts-config auto picks the only tsconfig*.json whose compilerOptions.paths
match the unresolved imports (none when several match). Without it, such imports get a ts-config-hint finding with the flag.

Units (skipped by --no-units) also read call sites: a child process started with a literal program (JS/TS spawn,
execFile, fork, execa; Rust Command::new; Tauri sidecars), or an HTTP call whose literal path matches the routes of
exactly one other container, becomes a runtime-link edge at pattern confidence; a program built at runtime is an unknown.

--history reads git log (read only): churn per file, Go package and container over a window anchored at the scanned
commit's date, and co-change-without-link signals for containers that change together with no static link.

Tests: scan marks files matching --test-globs (default: ${DEFAULT_TEST_GLOBS.join(', ')}) as test; labels show
the test share, e.g. "imports x152 (test x148)". --no-tests (render, diff) leaves imports from test files out.

affected: JSON with the files that import the changed ones directly or indirectly (reverse closure, changed files
included), the test files among them, and "blind": every reason the answer may be incomplete (changed files not in
the graph, unresolved imports that may point into it, skipped analyses, a stale snapshot). Run everything when blind
is not empty. --base reads git diff --name-only <ref> in --repo (default: current directory).

Exit codes: 0 ok, 1 --fail-on threshold reached or invalid document, 2 usage or tool error.
--nest-entry EXECUTES the target's module top-level code (providers are not instantiated). Use only on trusted code.`;

const OPTIONS = {
  output: { type: 'string', short: 'o' }, ref: { type: 'string' },
  paths: { type: 'string' }, exclude: { type: 'string' }, 'ts-config': { type: 'string' },
  history: { type: 'boolean' }, since: { type: 'string' }, 'co-change-min': { type: 'string' },
  'test-globs': { type: 'string' }, 'no-tests': { type: 'boolean' },
  changed: { type: 'string', multiple: true }, base: { type: 'string' }, repo: { type: 'string' }, ignore: { type: 'string' },
  'no-js': { type: 'boolean' }, 'no-units': { type: 'boolean' }, model: { type: 'string' }, go: { type: 'string' },
  'nest-entry': { type: 'string' }, 'nest-export': { type: 'string' },
  format: { type: 'string' }, 'fail-on': { type: 'string' },
  within: { type: 'string' }, focus: { type: 'string' }, 'max-nodes': { type: 'string' }, 'max-edges': { type: 'string' },
  view: { type: 'string' }, depth: { type: 'string' }, compare: { type: 'string' }, externals: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const out = (text, file) => (file ? writeFileSync(file, text) : process.stdout.write(text));
const usageError = (msg) => { const e = new Error(msg); e.code = 'USAGE'; throw e; };
const positive = (v, name) => { if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < 1) usageError(`--${name} must be a positive integer`); return n; };
const oneOf = (v, allowed, name) => { if (v !== undefined && !allowed.includes(v)) usageError(`--${name} must be one of: ${allowed.join(', ')}`); return v; };

function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [cmd, ...args] = positionals;
  if (o.help || !cmd) { process.stdout.write(`${USAGE}\n`); return cmd || o.help ? 0 : 2; }
  switch (cmd) {
    case 'scan': {
      if (args.length !== 1) usageError('scan needs exactly one <dir>');
      const snap = (o.ref ? (d, x) => scanRef(d, o.ref, x) : scan)(args[0], {
        paths: o.paths?.split(','), exclude: o.exclude, tsConfig: o['ts-config'], js: !o['no-js'], units: !o['no-units'], model: o.model,
        history: !!o.history, since: o.since, coChangeMin: positive(o['co-change-min'], 'co-change-min'),
        testGlobs: o['test-globs']?.split(',').map((g) => g.trim()).filter(Boolean), go: o.go ?? 'auto', nestEntry: o['nest-entry'], nestExport: o['nest-export'],
      });
      out(`${JSON.stringify(snap, null, 2)}\n`, o.output);
      const c = { error: 0, signal: 0, unknown: 0 };
      for (const f of snap.findings) c[f.level]++;
      process.stderr.write(`archsieve: ${snap.nodes.length} nodes, ${snap.edges.length} edges; findings: ${c.error} error, ${c.signal} signal, ${c.unknown} unknown\n`);
      return 0;
    }
    case 'diff': {
      if (args.length !== 2) usageError('diff needs <before.json> <after.json>');
      const format = oneOf(o.format ?? 'json', ['json', 'md'], 'format');
      const failOn = oneOf(o['fail-on'] ?? 'none', ['error', 'signal', 'none'], 'fail-on');
      const depth = Number(o.depth ?? 2);
      if (!Number.isInteger(depth) || depth < 1) usageError('--depth must be a positive integer');
      const d = diff(readJson(args[0]), readJson(args[1]), { depth, noTests: !!o['no-tests'] });
      out(format === 'md' ? toMarkdown(d) : `${JSON.stringify(d, null, 2)}\n`, o.output);
      const n = d.summary.newFindings;
      process.stderr.write(`archsieve: new findings: ${n.error} error, ${n.signal} signal, ${n.unknown} unknown\n`);
      if (failOn === 'error' && n.error > 0) return 1;
      if (failOn === 'signal' && n.error + n.signal > 0) return 1;
      return 0;
    }
    case 'render': {
      if (args.length !== 1) usageError('render needs <snapshot.json>');
      const view = oneOf(o.view ?? 'components', ['components', 'files', 'nest', 'containers'], 'view');
      const format = oneOf(o.format ?? 'mermaid', ['mermaid', 'dot', 'md'], 'format');
      const depth = Number(o.depth ?? 2);
      if (!Number.isInteger(depth) || depth < 1) usageError('--depth must be a positive integer');
      const budget = (v, name, dflt) => { const n = Number(v ?? dflt); if (!Number.isInteger(n) || n < 0) usageError(`--${name} must be a non-negative integer (0 disables it)`); return n; };
      const d = buildDiagram(readJson(args[0]), {
        view, depth, externals: !!o.externals, within: o.within ?? null, focus: o.focus ?? null,
        maxNodes: budget(o['max-nodes'], 'max-nodes', 40), maxEdges: budget(o['max-edges'], 'max-edges', 100),
        before: o.compare ? readJson(o.compare) : null, noTests: !!o['no-tests'],
      });
      out(format === 'md' ? toMarkdownView(d) : format === 'dot' ? toDot(d.projection, { title: d.title }) : toMermaid(d.projection, { title: d.title }), o.output);
      return 0;
    }
    case 'affected': {
      if (args.length < 1) usageError('affected needs <snapshot.json>');
      const changed = [...(o.changed ?? []), ...args.slice(1)];
      if (!changed.length && !o.base) usageError('affected needs --changed <file> ... or --base <git-ref>');
      const d = affected(readJson(args[0]), { changed, base: o.base ?? null, repo: o.repo ?? '.', ignore: o.ignore?.split(',').map((g) => g.trim()).filter(Boolean) ?? [] });
      out(`${JSON.stringify(d, null, 2)}\n`, o.output);
      process.stderr.write(`archsieve: ${d.files.length} affected files, ${d.tests.length} tests; blind: ${d.blind.length}\n`);
      return 0;
    }
    case 'validate': {
      if (args.length !== 1) usageError('validate needs one file');
      const errors = validate(readJson(args[0]));
      if (errors.length) { process.stderr.write(`invalid:\n${errors.join('\n')}\n`); return 1; }
      process.stderr.write('valid\n');
      return 0;
    }
    default:
      usageError(`unknown command: ${cmd}`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`archsieve: error [${e.code ?? 'ERROR'}]: ${e.message}\n`);
  if (e.code === 'USAGE') process.stderr.write(`\n${USAGE}\n`);
  process.exitCode = 2;
}
