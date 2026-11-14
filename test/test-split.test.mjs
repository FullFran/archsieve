import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

// fixtures/test-split: app/src/main.mjs (production) and two test files (app/src/util.spec.mjs,
// app/test/main.test.mjs) import lib/src; only the test file imports lib/src/fixtures.mjs.
function scanSplit(t, extra = [], dir = fixture('test-split')) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', dir, '--go', 'none', '-o', out, ...extra]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return { file: out, snap: readJson(out) };
}

const testFiles = (snap) => snap.nodes.filter((n) => n.test).map((n) => n.id);

test('S1 scan: files matching the default test globs are marked test, production files are not', (t) => {
  const { snap } = scanSplit(t);
  assert.equal(snap.schemaVersion, '0.3');
  assert.deepEqual(testFiles(snap), ['app/src/util.spec.mjs', 'app/test/main.test.mjs']);
  const a = snap.analyses.find((x) => x.tool === 'test globs');
  assert.equal(a.status, 'ok');
  assert.match(a.note, /2 test files/);
  assert.match(a.note, /\*\*\/test\/\*\*/);
});

test('S1 scan: --test-globs replaces the defaults', (t) => {
  const { snap } = scanSplit(t, ['--test-globs', '**/*.spec.*']);
  assert.deepEqual(testFiles(snap), ['app/src/util.spec.mjs']);
});

test('S1 scan: a depends-on link counts the imports that come from test files', (t) => {
  const { snap } = scanSplit(t);
  const link = snap.edges.find((e) => e.kind === 'depends-on' && e.source === 'container:app' && e.target === 'container:lib');
  assert.deepEqual(link.relations, { imports: 4 });
  assert.deepEqual(link.testRelations, { imports: 3 });
});

test('S1 render: container and component labels show the test share; --no-tests hides test edges', (t) => {
  const { file } = scanSplit(t);
  const containers = cli(['render', file, '--view', 'containers']);
  assert.equal(containers.code, 0, containers.stderr);
  assert.match(containers.stdout, /\|"imports x4 \(test x3\)"\|/);
  const comps = cli(['render', file, '--depth', '2']).stdout;
  assert.match(comps, /\|"imports x2 \(test x1\)"\|/, 'app/src -> lib/src: one production, one spec import');
  assert.match(comps, /\|"imports x2 \(test x2\)"\|/, 'app/test -> lib/src: test imports only');

  const prodContainers = cli(['render', file, '--view', 'containers', '--no-tests']).stdout;
  assert.match(prodContainers, /\|"imports"\|/);
  assert.doesNotMatch(prodContainers, /test x/);
  const prod = cli(['render', file, '--depth', '2', '--no-tests', '--format', 'md']);
  assert.equal(prod.code, 0, prod.stderr);
  assert.doesNotMatch(prod.stdout, /app\/test/, 'a folder with only test files disappears');
  assert.doesNotMatch(prod.stdout, /test x/);
  assert.match(prod.stdout, /test imports hidden \(--no-tests\): 4/, 'the scope line says what was hidden');
});

test('S1 diff: --no-tests keeps a coupling added only by tests out of the component dependencies', (t) => {
  const before = scanSplit(t);
  const repo = join(scratch(t), 'repo');
  cpSync(fixture('test-split'), repo, { recursive: true });
  mkdirSync(join(repo, 'lib', 'testkit'));
  writeFileSync(join(repo, 'lib', 'testkit', 'kit.mjs'), 'export const kit = 1;\n');
  writeFileSync(join(repo, 'app', 'test', 'kit.test.mjs'), "import { kit } from '../../lib/testkit/kit.mjs';\nexport const k = kit;\n");
  const after = scanSplit(t, [], repo);
  const out = join(scratch(t), 'd.json');
  assert.equal(cli(['diff', before.file, after.file, '-o', out]).code, 0);
  const all = readJson(out).components.dependencies.added;
  assert.deepEqual(all, [{ from: 'app/test', to: 'lib/testkit', fileEdges: 1, testEdges: 1 }]);
  assert.equal(cli(['validate', out]).code, 0);
  assert.equal(cli(['diff', before.file, after.file, '--no-tests', '-o', out]).code, 0);
  const d = readJson(out);
  assert.deepEqual(d.components.dependencies.added, []);
  assert.ok(d.warnings.some((w) => /--no-tests/.test(w)), 'the diff says test edges were left out');
  assert.equal(cli(['validate', out]).code, 0);
});

test('S1 regression: snapshots without test marks still render and diff', (t) => {
  const { file, snap } = scanSplit(t);
  for (const n of snap.nodes) delete n.test;
  for (const e of snap.edges) delete e.testRelations;
  snap.schemaVersion = '0.2';
  const old = join(scratch(t), 'old.json');
  writeFileSync(old, JSON.stringify(snap));
  assert.equal(cli(['validate', old]).code, 0);
  assert.match(cli(['render', old, '--view', 'containers']).stdout, /\|"imports x4"\|/);
  assert.equal(cli(['diff', old, file, '--no-tests', '-o', join(scratch(t), 'd.json')]).code, 0);
});
