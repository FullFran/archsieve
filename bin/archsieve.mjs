#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { scan, scanRef } from '../src/scan.mjs';
import { diff, toMarkdown } from '../src/diff.mjs';
import { project, compareProjections, toMermaid, toDot } from '../src/render.mjs';
import { validate } from '../src/validate.mjs';

const USAGE = `archsieve: architecture evidence for coding agents (V0, experimental)

Usage:
  archsieve scan <dir> [--ref <git-ref>] [-o snapshot.json] [--paths a,b] [--exclude <regex, added to defaults>] [--ts-config <file>]
                       [--no-js] [--no-units] [--go auto|none|<dir,...>] [--nest-entry <compiled module.js> [--nest-export AppModule]]
  archsieve diff <before.json> <after.json> [--format json|md] [--depth N] [-o file] [--fail-on error|signal|none]
  archsieve render <snapshot.json> [--view components|files|nest] [--depth N] [--format mermaid|dot]
                       [--compare <before.json>] [--externals] [-o file]
  archsieve validate <snapshot-or-diff.json>

Exit codes: 0 ok, 1 --fail-on threshold reached or invalid document, 2 usage or tool error.
--nest-entry EXECUTES the target's module top-level code (providers are not instantiated). Use only on trusted code.`;

const OPTIONS = {
  output: { type: 'string', short: 'o' }, ref: { type: 'string' },
  paths: { type: 'string' }, exclude: { type: 'string' }, 'ts-config': { type: 'string' },
  'no-js': { type: 'boolean' }, 'no-units': { type: 'boolean' }, go: { type: 'string' },
  'nest-entry': { type: 'string' }, 'nest-export': { type: 'string' },
  format: { type: 'string' }, 'fail-on': { type: 'string' },
  view: { type: 'string' }, depth: { type: 'string' }, compare: { type: 'string' }, externals: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const out = (text, file) => (file ? writeFileSync(file, text) : process.stdout.write(text));
const usageError = (msg) => { const e = new Error(msg); e.code = 'USAGE'; throw e; };
const oneOf = (v, allowed, name) => { if (v !== undefined && !allowed.includes(v)) usageError(`--${name} must be one of: ${allowed.join(', ')}`); return v; };

function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [cmd, ...args] = positionals;
  if (o.help || !cmd) { process.stdout.write(`${USAGE}\n`); return cmd || o.help ? 0 : 2; }
  switch (cmd) {
    case 'scan': {
      if (args.length !== 1) usageError('scan needs exactly one <dir>');
      const snap = (o.ref ? (d, x) => scanRef(d, o.ref, x) : scan)(args[0], {
        paths: o.paths?.split(','), exclude: o.exclude, tsConfig: o['ts-config'], js: !o['no-js'], units: !o['no-units'],
        go: o.go ?? 'auto', nestEntry: o['nest-entry'], nestExport: o['nest-export'],
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
      const d = diff(readJson(args[0]), readJson(args[1]), { depth });
      out(format === 'md' ? toMarkdown(d) : `${JSON.stringify(d, null, 2)}\n`, o.output);
      const n = d.summary.newFindings;
      process.stderr.write(`archsieve: new findings: ${n.error} error, ${n.signal} signal, ${n.unknown} unknown\n`);
      if (failOn === 'error' && n.error > 0) return 1;
      if (failOn === 'signal' && n.error + n.signal > 0) return 1;
      return 0;
    }
    case 'render': {
      if (args.length !== 1) usageError('render needs <snapshot.json>');
      const view = oneOf(o.view ?? 'components', ['components', 'files', 'nest'], 'view');
      const format = oneOf(o.format ?? 'mermaid', ['mermaid', 'dot'], 'format');
      const depth = Number(o.depth ?? 2);
      if (!Number.isInteger(depth) || depth < 1) usageError('--depth must be a positive integer');
      const pOpts = { view, depth, externals: !!o.externals };
      const after = readJson(args[0]);
      let p = project(after, pOpts);
      if (o.compare) p = compareProjections(project(readJson(o.compare), pOpts), p);
      const title = `${after.subject.name}${after.subject.commit ? `@${after.subject.commit.slice(0, 10)}` : ''} (${view}${o.compare ? ', compared' : ''})`;
      out(format === 'dot' ? toDot(p, { title }) : toMermaid(p, { title }), o.output);
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
