import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cli, scratch, fixture, readJson, compileNestFixtures } from './helpers.mjs';

before(compileNestFixtures);

function scanNest(t, state) {
  const out = join(scratch(t), `${state}.json`);
  const r = cli(['scan', fixture('nest-shop', state), '--nest-entry', 'dist/app.module.js', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  return { file: out, snap: readJson(out) };
}

const rules = (snap, level) => snap.findings.filter((f) => f.level === level).map((f) => f.rule).sort();

test('clean fixture: layered imports, no cycles, schema-valid', (t) => {
  const { file, snap } = scanNest(t, 'before');
  assert.deepEqual(rules(snap, 'error'), []);
  assert.ok(snap.nodes.some((n) => n.id === 'nest:module:UsersModule'));
  assert.ok(snap.edges.some((e) => e.kind === 'nest-injects' && e.source.endsWith('/OrdersService') && e.target.endsWith('/UsersService')));
  assert.ok(snap.edges.every((e) => e.evidence.length > 0), 'every edge carries provenance');
  assert.equal(cli(['validate', file]).code, 0);
});

test('controlled change: runtime cycles are errors, type-only cycle and single-binding token are signals, factory is unknown', (t) => {
  const { snap } = scanNest(t, 'after');
  assert.deepEqual(rules(snap, 'error'), ['di-cycle', 'module-cycle', 'no-circular', 'no-circular']);
  assert.deepEqual(rules(snap, 'signal'), ['token-indirection', 'type-only-cycle']);
  assert.deepEqual(rules(snap, 'unknown'), ['non-class-provider']);
});

test('repeated scans are byte-identical (deterministic)', (t) => {
  const a = scanNest(t, 'after'), b = scanNest(t, 'after');
  assert.equal(readFileSync(a.file, 'utf8'), readFileSync(b.file, 'utf8'));
});

test('diff reports the induced regression and --fail-on error exits 1', (t) => {
  const b = scanNest(t, 'before'), a = scanNest(t, 'after');
  const out = join(scratch(t), 'diff.json');
  const r = cli(['diff', b.file, a.file, '-o', out, '--fail-on', 'error']);
  assert.equal(r.code, 1);
  const d = readJson(out);
  assert.deepEqual(d.summary.newFindings, { error: 4, signal: 2, unknown: 1 });
  assert.ok(d.nodes.added.some((n) => n.id === 'src/users/repository/users.repository.ts'));
  assert.ok(d.components.dependencies.added.some((x) => x.from === 'src/users' && x.to === 'src/orders'));
  assert.equal(cli(['validate', out]).code, 0);
  assert.equal(cli(['diff', b.file, a.file, '-o', out]).code, 0, 'default --fail-on none never fails');
  assert.equal(cli(['diff', a.file, a.file, '--fail-on', 'error', '-o', out]).code, 0, 'no change, no failure');
});

test('render: compared views mark added elements and stay deterministic', (t) => {
  const b = scanNest(t, 'before'), a = scanNest(t, 'after');
  const r1 = cli(['render', a.file, '--view', 'nest', '--compare', b.file]);
  const r2 = cli(['render', a.file, '--view', 'nest', '--compare', b.file]);
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(r1.stdout, r2.stdout);
  assert.match(r1.stdout, /\["InMemoryUsersRepository"\]:::added/);
  const dot = cli(['render', a.file, '--view', 'files', '--format', 'dot']);
  assert.match(dot.stdout, /^digraph archsieve \{/);
});

test('render: plain Mermaid views carry their own colours so they read on light and dark themes', (t) => {
  const a = scanNest(t, 'after');
  const files = cli(['render', a.file, '--view', 'files', '--externals']).stdout;
  assert.match(files, /^ {2}linkStyle default stroke:#8c959f/m, 'edges get a mid-grey visible on both themes');
  assert.match(files, /^ {2}classDef code fill:#ddf4ff,stroke:#0969da,color:#1f2328$/m);
  assert.match(files, /^ {2}classDef external fill:#fff8c5,stroke:#9a6700,color:#1f2328$/m);
  assert.match(files, /\["src\/users\/users\.service\.ts"\]:::code/);
  assert.match(files, /\(\["npm:@nestjs\/common"\]\):::external/);
  const nest = cli(['render', a.file, '--view', 'nest']).stdout;
  assert.match(nest, /^ {2}style n\d+ fill:#fbefff,stroke:#8250df,color:#1f2328$/m, 'module subgraphs are coloured too');
});

test('unresolvable and computed imports are reported as unknown, not as edges', (t) => {
  const out = join(scratch(t), 's.json');
  assert.equal(cli(['scan', fixture('js-unknowns'), '-o', out]).code, 0);
  const snap = readJson(out);
  const unknown = snap.findings.filter((f) => f.level === 'unknown');
  assert.ok(unknown.some((f) => f.evidence[0].detail === './codegen/client.mjs'));
  assert.ok(!snap.nodes.some((n) => n.id.includes('codegen')), 'no node invented for an unresolved import');
  assert.ok(snap.edges.some((e) => e.target === 'helper.mjs'));
  // Known limitation, pinned on purpose: a computed import(`./plugins/${name}.mjs`) is invisible to
  // dependency-cruiser, so it is neither an edge nor a finding. It is covered only by `limitations`.
  assert.ok(!JSON.stringify(snap.findings).includes('plugins'));
  assert.match(snap.limitations.join(' '), /computed dynamic imports/);
});

test('packages resolving into dist/ inside node_modules are kept as external dependencies', (t) => {
  const out = join(scratch(t), 's.json');
  assert.equal(cli(['scan', fixture('js-npm-dist'), '-o', out]).code, 0);
  const snap = readJson(out);
  assert.ok(snap.edges.some((e) => e.source === 'main.mjs' && e.target === 'npm:ajv'));
  assert.ok(snap.nodes.some((n) => n.id === 'npm:ajv' && n.kind === 'external-package'));
});

test('go packages come from go list', (t) => {
  const out = join(scratch(t), 's.json');
  assert.equal(cli(['scan', fixture('go-mini'), '--no-js', '--go', '.', '-o', out]).code, 0);
  const snap = readJson(out);
  assert.ok(snap.edges.some((e) => e.source === 'go:example.com/gomini/internal/a' && e.target === 'go:example.com/gomini/internal/b'));
  assert.ok(!snap.nodes.some((n) => n.id === 'go:strings'), 'standard library omitted');
});

test('missing Go toolchain is reported as skipped, never as a silent success', (t) => {
  const out = join(scratch(t), 's.json');
  const r = cli(['scan', fixture('go-mini'), '--go', '.', '-o', out], { env: { ...process.env, PATH: '/nonexistent' } });
  assert.equal(r.code, 0, r.stderr);
  const a = readJson(out).analyses.find((x) => x.tool === 'go list');
  assert.equal(a.status, 'skipped');
});

test('bad input and usage errors exit 2 with a clear code', () => {
  const r = cli(['scan', '/definitely/not/here']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\[BAD_INPUT\]/);
  assert.equal(cli(['render', 'x.json', '--view', 'bogus']).code, 2);
  assert.equal(cli(['frobnicate']).code, 2);
});

test('validate rejects a document that breaks the schema', (t) => {
  const f = join(scratch(t), 'bad.json');
  const doc = { schemaVersion: '0.1', kind: 'archsieve-snapshot', subject: { name: 'x', commit: null, dirty: null }, tools: [], analyses: [],
    nodes: [{ id: 'a', kind: 'galaxy', evidence: [] }], edges: [], findings: [], limitations: [] };
  writeFileSync(f, JSON.stringify(doc));
  const r = cli(['validate', f]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid/);
});

test('--ref scans committed states without touching the working tree', (t) => {
  const repo = scratch(t);
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q');
  writeFileSync(join(repo, 'a.mjs'), "import { b } from './b.mjs';\nexport const a = () => b();\n");
  writeFileSync(join(repo, 'b.mjs'), 'export const b = () => 1;\n');
  git('add', '.'); git('commit', '-qm', 'one');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'b.mjs'), "import { a } from './a.mjs';\nexport const b = () => a;\n");
  git('commit', '-qam', 'two');
  writeFileSync(join(repo, 'b.mjs'), 'uncommitted edit that must be ignored\n');
  const dir = scratch(t);
  assert.equal(cli(['scan', repo, '--ref', first, '-o', join(dir, '1.json')]).code, 0);
  assert.equal(cli(['scan', repo, '--ref', 'HEAD', '-o', join(dir, '2.json')]).code, 0);
  const s2 = readJson(join(dir, '2.json'));
  assert.equal(readJson(join(dir, '1.json')).subject.commit, first);
  assert.equal(s2.subject.dirty, false);
  assert.ok(s2.findings.some((f) => f.rule === 'no-circular'), 'cycle from the commit, not from the dirty tree');
  assert.equal(cli(['diff', join(dir, '1.json'), join(dir, '2.json'), '--fail-on', 'error', '-o', join(dir, 'd.json')]).code, 1);
  assert.equal(readFileSync(join(repo, 'b.mjs'), 'utf8'), 'uncommitted edit that must be ignored\n', 'working tree untouched');
  assert.equal(cli(['scan', repo, '--ref', 'no-such-ref']).code, 2);
});
