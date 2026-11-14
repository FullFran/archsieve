import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { cli, scratch } from './helpers.mjs';

// Synthetic snapshots keep these tests independent of tsc and of the scan adapters.
// Layout: folders a0..a9, each with sub-folders s0..s5, each with two files f0 and f1.
// f0 of (K,J) imports f0 of (K,J+1) and f0 of (K+1,J), so the graph is a torus.
const ev = [{ tool: 'test' }];
const SHA = '0123456789abcdef0123456789abcdef01234567';

function synthetic({ skip = [], nest = false } = {}) {
  const nodes = [], edges = [];
  const edge = (source, target, extra = {}) => edges.push({ source, target, kind: 'imports', evidence: ev, ...extra });
  for (let k = 0; k < 10; k++) for (let j = 0; j < 6; j++) for (let m = 0; m < 2; m++) {
    const id = `a${k}/s${j}/f${m}.ts`;
    if (!skip.includes(id)) nodes.push({ id, kind: 'file', evidence: ev });
  }
  const has = new Set(nodes.map((n) => n.id));
  for (let k = 0; k < 10; k++) for (let j = 0; j < 6; j++) {
    const from = `a${k}/s${j}/f0.ts`;
    for (const to of [`a${k}/s${(j + 1) % 6}/f0.ts`, `a${(k + 1) % 10}/s${j}/f0.ts`]) if (has.has(from) && has.has(to)) edge(from, to);
  }
  edge('a0/s0/f1.ts', 'a2/s2/f1.ts', { typeOnly: true });
  if (nest) {
    nodes.length = 0; edges.length = 0;
    nodes.push({ id: 'nest:module:AppModule', kind: 'nest-module', file: 'src/app.module.ts', evidence: ev });
    nodes.push({ id: 'nest:module:UsersModule', kind: 'nest-module', file: 'src/users/users.module.ts', evidence: ev });
    nodes.push({ id: 'nest:provider:UsersService', kind: 'nest-provider', file: 'src/users/users.service.ts', module: 'nest:module:UsersModule', evidence: ev });
    if (!skip.includes('UsersRepo')) nodes.push({ id: 'nest:provider:UsersRepo', kind: 'nest-provider', file: 'src/users/users.repo.ts', module: 'nest:module:UsersModule', evidence: ev });
    edges.push({ source: 'nest:module:AppModule', target: 'nest:module:UsersModule', kind: 'nest-imports', evidence: ev });
    if (!skip.includes('UsersRepo')) edges.push({ source: 'nest:provider:UsersService', target: 'nest:provider:UsersRepo', kind: 'nest-injects', evidence: ev });
  }
  return { schemaVersion: '0.1', kind: 'archsieve-snapshot', subject: { name: 'synth', commit: SHA, dirty: false }, tools: [], analyses: [], nodes, edges, findings: [], limitations: [] };
}

function snapFile(t, snap, name = 's.json') {
  const f = join(scratch(t), name);
  writeFileSync(f, JSON.stringify(snap));
  assert.equal(cli(['validate', f]).code, 0, 'synthetic snapshot must be schema-valid');
  return f;
}

const sha10 = SHA.slice(0, 10);

test('S8.1 every diagram states its type and scope in its title (mermaid frontmatter and DOT label)', (t) => {
  const f = snapFile(t, synthetic());
  const comps = cli(['render', f, '--depth', '1']).stdout;
  assert.ok(comps.startsWith(`---\ntitle: "Components of synth@${sha10} (depth 1)"\n---\nflowchart LR`), comps.slice(0, 120));
  assert.match(cli(['render', f, '--view', 'files', '--within', 'a0/s0']).stdout, new RegExp(`^title: "Files of synth@${sha10} \\(within a0/s0\\)"$`, 'm'));
  const nest = snapFile(t, synthetic({ nest: true }), 'n.json');
  assert.match(cli(['render', nest, '--view', 'nest']).stdout, new RegExp(`^title: "Nest DI of synth@${sha10}"$`, 'm'));
  assert.match(cli(['render', f, '--depth', '1', '--focus', 'a0']).stdout, new RegExp(`^title: "Focus on a0 in Components of synth@${sha10} \\(depth 1\\)"$`, 'm'));
  const dot = cli(['render', f, '--depth', '1', '--format', 'dot']).stdout;
  assert.match(dot, new RegExp(`^ {2}label="Components of synth@${sha10} \\(depth 1\\)"; labelloc=t;$`, 'm'));
});

test('S8.2 --format md emits title, concern, scope line, mermaid block and a legend', (t) => {
  const f = snapFile(t, synthetic());
  const r = cli(['render', f, '--depth', '1', '--format', 'md']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.equal(lines[0], `## Components of synth@${sha10} (depth 1)`);
  assert.equal(lines[2], 'Which folders depend on which, and how?');
  assert.equal(lines[4], `Snapshot synth@${sha10} · showing 10 of 10 folders`);
  assert.match(r.stdout, /\n```mermaid\n---\ntitle: .*\n---\nflowchart LR\n[\s\S]*\n```\n/);
  assert.match(r.stdout, /\n\*\*Legend\*\*\n\n\| Mark \| Meaning \|\n\| --- \| --- \|\n/);
  const files = cli(['render', f, '--view', 'files', '--within', 'a0/s0', '--format', 'md']).stdout;
  assert.match(files, /\nWhich files import which\?\n/);
  const nest = cli(['render', snapFile(t, synthetic({ nest: true }), 'n.json'), '--view', 'nest', '--format', 'md']).stdout;
  assert.match(nest, /\nWhich Nest modules import each other, and which classes are injected where\?\n/);
  const focus = cli(['render', f, '--depth', '1', '--focus', 'a0', '--format', 'md']).stdout;
  assert.match(focus, /\nWhat does a0 use, and what uses a0\?\n/);
  const out = join(scratch(t), 'view.md');
  assert.equal(cli(['render', f, '--depth', '1', '--format', 'md', '-o', out]).code, 0);
  assert.equal(readFileSync(out, 'utf8'), r.stdout, '-o writes the same markdown');
  assert.equal(cli(['render', f, '--format', 'html']).code, 2);
});

test('S8.3 components view reduces depth to fit the budget and says so', (t) => {
  const f = snapFile(t, synthetic());
  const md = cli(['render', f, '--depth', '2', '--format', 'md']).stdout;
  assert.match(md, /^Snapshot synth@\w+ · showing 10 of 10 folders · depth reduced from 2 to 1 to fit 40 boxes and 100 arrows$/m);
  assert.match(md, /^## Components of synth@\w+ \(depth 1\)$/m, 'the title carries the effective depth');
  const fits = cli(['render', f, '--depth', '2', '--format', 'md', '--max-nodes', '60', '--max-edges', '200']).stdout;
  assert.match(fits, /showing 60 of 60 folders$/m);
  assert.doesNotMatch(fits, /reduced/);
  const still = cli(['render', f, '--depth', '2', '--format', 'md', '--max-nodes', '5']).stdout;
  assert.match(still, /depth reduced from 2 to 1 to fit 5 boxes and 100 arrows · still exceeds the budget: 10 boxes \(max 5\)$/m);
  const only = cli(['render', f, '--depth', '1', '--format', 'md', '--max-nodes', '5']);
  assert.equal(only.code, 0);
  assert.match(only.stdout, /exceeds the budget: 10 boxes \(max 5\)$/m);
});

test('S8.3 files and nest views over budget exit 2 with a hint; --max-nodes 0 disables the node budget', (t) => {
  const f = snapFile(t, synthetic());
  const r = cli(['render', f, '--view', 'files']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /120 nodes/);
  assert.match(r.stderr, /--within <dir>/);
  assert.match(r.stderr, /--focus <id>/);
  assert.match(r.stderr, /--view components/);
  assert.equal(r.stdout, '');
  assert.equal(cli(['render', f, '--view', 'files', '--max-nodes', '0', '--max-edges', '0']).code, 0);
  assert.equal(cli(['render', f, '--view', 'files', '--max-nodes', '0']).code, 2, 'the edge budget still applies');
  const n = snapFile(t, synthetic({ nest: true }), 'n.json');
  assert.equal(cli(['render', n, '--view', 'nest', '--max-nodes', '2']).code, 2);
  assert.equal(cli(['render', f, '--max-nodes', 'x']).code, 2);
});

test('S8.4 --within keeps one folder and collapses outside neighbours into dashed boundary boxes', (t) => {
  const f = snapFile(t, synthetic());
  const md = cli(['render', f, '--within', 'a0', '--format', 'md']).stdout;
  assert.match(md, /^## Components of synth@\w+ \(depth 2, within a0\)$/m);
  assert.match(md, /^Snapshot synth@\w+ · showing 6 of 60 folders · within a0 \(outside neighbours collapsed into 3 boundary boxes\)$/m);
  assert.match(md, /\["a0\/s0"\]:::code/);
  assert.match(md, /\["a1\/ \(outside\)"\]:::boundary/);
  assert.match(md, /\["a9\/ \(outside\)"\]:::boundary/);
  assert.match(md, /\["a2\/ \(outside\)"\]:::boundary/, 'the type-only neighbour is a boundary too');
  assert.doesNotMatch(md, /"a3/, 'non-neighbours are not drawn');
  assert.match(md, /classDef boundary [^\n]*stroke-dasharray/);
  assert.match(md, /\| Dashed grey box \|/, 'the legend explains the boundary style');
  const files = cli(['render', f, '--view', 'files', '--within', 'a0/s0', '--format', 'md']).stdout;
  assert.match(files, /showing 2 of 120 files · within a0\/s0 \(outside neighbours collapsed into 4 boundary boxes\)/);
  assert.match(files, /\["a0\/s0\/f0\.ts"\]:::code/);
  assert.doesNotMatch(files, /"a0\/s1\/f0\.ts"/);
  assert.equal(cli(['render', f, '--within', '/']).code, 2);
});

test('S8.5 --focus shows one element with its direct dependencies and dependents only', (t) => {
  const f = snapFile(t, synthetic());
  const md = cli(['render', f, '--focus', 'a0/s0', '--max-nodes', '60', '--max-edges', '200', '--format', 'md']).stdout;
  assert.match(md, /showing 6 of 60 folders · focus on a0\/s0 \(direct dependencies and dependents only\)/);
  for (const x of ['a0/s0', 'a0/s1', 'a1/s0', 'a0/s5', 'a9/s0', 'a2/s2']) assert.ok(md.includes(`["${x}"]`), x);
  assert.doesNotMatch(md, /"a0\/s2"/);
  assert.equal((md.match(/-->/g) ?? []).length + (md.match(/-\.->/g) ?? []).length, 5, 'edges among the neighbours are not drawn');
  assert.match(md, /\["a0\/s0"\]:::focus/);
  const byFile = cli(['render', f, '--view', 'files', '--focus', 'a0/s0/f0.ts', '--format', 'md']);
  assert.equal(byFile.code, 0, byFile.stderr);
  assert.match(byFile.stdout, /showing 5 of 120 files/);
  const bad = cli(['render', f, '--focus', 'nope/x']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /nope\/x/);
});

test('S8.6 the same input gives byte-identical output in every format', (t) => {
  const f = snapFile(t, synthetic());
  for (const args of [['--depth', '1'], ['--within', 'a0'], ['--focus', 'a0/s0', '--max-nodes', '0']]) {
    for (const format of ['mermaid', 'dot', 'md']) {
      const a = cli(['render', f, ...args, '--format', format]), b = cli(['render', f, ...args, '--format', format]);
      assert.equal(a.code, 0, a.stderr);
      assert.equal(a.stdout, b.stdout);
      assert.doesNotMatch(a.stdout, /\d{4}-\d{2}-\d{2}T/, 'no timestamps');
    }
  }
});

test('S8.7 the md legend explains exactly the styles used, never colour alone', (t) => {
  const f = snapFile(t, synthetic());
  const md = cli(['render', f, '--depth', '1', '--format', 'md']).stdout;
  const legend = md.slice(md.indexOf('**Legend**'));
  assert.match(legend, /\| Blue box \| Folder/);
  assert.match(legend, /\| Solid arrow labelled `imports` \|/);
  assert.match(legend, /\| `x3` after a label \|/);
  assert.match(legend, /\| Dashed arrow labelled `type-only` \|/);
  assert.doesNotMatch(legend, /lazy|Yellow|Purple|Green|Red|Dashed grey|Thick/);
  const focus = cli(['render', f, '--depth', '1', '--focus', 'a0', '--format', 'md']).stdout;
  assert.match(focus.slice(focus.indexOf('**Legend**')), /\| Thick-bordered box \|/);
  const before = snapFile(t, synthetic({ skip: ['a0/s0/f1.ts'] }), 'b.json');
  const cmp = cli(['render', f, '--depth', '1', '--compare', before, '--max-nodes', '0', '--format', 'md']).stdout;
  assert.match(cmp, /^## Components of synth@\w+ \(depth 1, compared\)$/m);
  assert.match(cmp.slice(cmp.indexOf('**Legend**')), /\| Thick green arrow \|/);
  const nest = cli(['render', snapFile(t, synthetic({ nest: true }), 'n.json'), '--view', 'nest', '--format', 'md']).stdout;
  const nl = nest.slice(nest.indexOf('**Legend**'));
  assert.match(nl, /\| Purple double-bordered box \|/);
  assert.match(nl, /\| Dashed arrow labelled `imports` \|/);
  assert.match(nl, /\| Solid arrow labelled `injects` \|/);
});

test('S8 regression: nest --compare keeps :::added and still opens with a frontmatter title', (t) => {
  const before = snapFile(t, synthetic({ nest: true, skip: ['UsersRepo'] }), 'before.json');
  const after = snapFile(t, synthetic({ nest: true }), 'after.json');
  const r = cli(['render', after, '--view', 'nest', '--compare', before]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\["UsersRepo"\]:::added/);
  assert.match(r.stdout, /^---\ntitle: "Nest DI of synth@\w+ \(compared\)"\n---\nflowchart LR\n/);
  const md = cli(['render', after, '--view', 'nest', '--compare', before, '--format', 'md']).stdout;
  assert.match(md, /\| Green box with thick border \|/);
});
