import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

function scanTo(t, dir, extra = []) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', dir, '-o', out, ...extra]);
  assert.equal(r.code, 0, r.stderr);
  return out;
}

function affected(snap, args) {
  const r = cli(['affected', snap, ...args]);
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.kind, 'archsieve-affected');
  return doc;
}

// fixtures/test-split: app/src/main.mjs, app/src/util.spec.mjs and app/test/main.test.mjs import
// lib/src/core.mjs; app/test/main.test.mjs also imports app/src/main.mjs and lib/src/fixtures.mjs.
test('S2 affected: the reverse closure of a changed file, and the tests inside it', (t) => {
  const snap = scanTo(t, fixture('test-split'), ['--go', 'none']);
  const d = affected(snap, ['--changed', 'lib/src/core.mjs']);
  assert.deepEqual(d.changed, ['lib/src/core.mjs']);
  assert.deepEqual(d.files, ['app/src/main.mjs', 'app/src/util.spec.mjs', 'app/test/main.test.mjs', 'lib/src/core.mjs']);
  assert.deepEqual(d.tests, ['app/src/util.spec.mjs', 'app/test/main.test.mjs']);
  assert.deepEqual(d.blind, []);
  const narrow = affected(snap, ['--changed', 'lib/src/fixtures.mjs']);
  assert.deepEqual(narrow.files, ['app/test/main.test.mjs', 'lib/src/fixtures.mjs']);
  assert.deepEqual(narrow.tests, ['app/test/main.test.mjs']);
  const f = join(scratch(t), 'a.json');
  assert.equal(cli(['affected', snap, '--changed', 'lib/src/core.mjs', '-o', f]).code, 0);
  assert.equal(cli(['validate', f]).code, 0, 'affected output is schema-valid');
});

test('S2 affected: changed files outside the graph are blind; --ignore drops files the caller knows are irrelevant', (t) => {
  const snap = scanTo(t, fixture('test-split'), ['--go', 'none']);
  const d = affected(snap, ['--changed', 'app/src/main.mjs', '--changed', 'app/package.json', 'README.md']);
  assert.deepEqual(d.changed, ['README.md', 'app/package.json', 'app/src/main.mjs']);
  assert.deepEqual(d.files, ['app/src/main.mjs', 'app/test/main.test.mjs']);
  assert.deepEqual(d.blind, [
    { reason: 'not-in-graph', file: 'README.md' },
    { reason: 'not-in-graph', file: 'app/package.json' },
  ]);
  const ig = affected(snap, ['--changed', 'README.md', '--changed', 'app/src/main.mjs', '--ignore', '**/*.md']);
  assert.deepEqual(ig.ignored, ['README.md']);
  assert.deepEqual(ig.blind, []);
});

test('S2 affected: an unresolved import that may point into the closure makes the result blind', (t) => {
  // fixtures/js-unknowns/main.mjs imports ./helper.mjs and the unresolvable ./codegen/client.mjs.
  const snap = scanTo(t, fixture('js-unknowns'));
  const d = affected(snap, ['--changed', 'codegen/client.mjs']);
  assert.deepEqual(d.files, []);
  assert.deepEqual(d.blind, [
    { reason: 'not-in-graph', file: 'codegen/client.mjs' },
    { reason: 'unresolved-import', file: 'main.mjs', detail: './codegen/client.mjs' },
  ]);
  const clear = affected(snap, ['--changed', 'helper.mjs']);
  assert.deepEqual(clear.files, ['helper.mjs', 'main.mjs']);
  assert.deepEqual(clear.blind, [], 'an unresolved import whose name matches nothing in the closure is not on the path');
  assert.match(clear.limitations.join(' '), /computed dynamic imports/);
});

test('S2 affected: a changed Go file maps to its package, and its importers follow', (t) => {
  const snap = scanTo(t, fixture('go-mini'), ['--no-js', '--go', '.']);
  const d = affected(snap, ['--changed', 'internal/b/b.go']);
  assert.ok(d.files.includes('go:example.com/gomini/internal/b'));
  assert.ok(d.files.includes('go:example.com/gomini/internal/a'));
  assert.deepEqual(d.blind, []);
});

test('S2 affected: snapshots without test marks say so instead of returning an empty test list', (t) => {
  const snapFile = scanTo(t, fixture('test-split'), ['--go', 'none']);
  const snap = readJson(snapFile);
  for (const n of snap.nodes) delete n.test;
  snap.analyses = snap.analyses.filter((a) => a.tool !== 'test globs');
  writeFileSync(snapFile, JSON.stringify(snap));
  const d = affected(snapFile, ['--changed', 'lib/src/core.mjs']);
  assert.deepEqual(d.tests, []);
  assert.deepEqual(d.blind, [{ reason: 'no-test-marks', detail: 'the snapshot predates the test/production split; rescan with archsieve >= 0.3' }]);
});

test('S2 affected --base: reads git diff --name-only and flags a snapshot from another commit', (t) => {
  const repo = join(scratch(t), 'repo');
  cpSync(fixture('test-split'), repo, { recursive: true });
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'one');
  const stale = scanTo(t, repo, ['--go', 'none']);
  writeFileSync(join(repo, 'lib', 'src', 'fixtures.mjs'), 'export const makeUser = () => ({ id: 2 });\n');
  git('commit', '-qam', 'two');
  const fresh = scanTo(t, repo, ['--go', 'none']);
  const d = affected(fresh, ['--base', 'HEAD~1', '--repo', repo]);
  assert.deepEqual(d.changed, ['lib/src/fixtures.mjs']);
  assert.deepEqual(d.tests, ['app/test/main.test.mjs']);
  assert.deepEqual(d.blind, []);
  const old = affected(stale, ['--base', 'HEAD~1', '--repo', repo]);
  assert.equal(old.blind[0].reason, 'stale-snapshot');
  assert.equal(cli(['affected', fresh, '--base', 'no-such-ref', '--repo', repo]).code, 2);
  assert.equal(cli(['affected', fresh]).code, 2, '--changed or --base is required');
});

test('S2 affected: every unresolved specifier of a file is checked, not only the first one', (t) => {
  const repo = scratch(t);
  writeFileSync(join(repo, 'main.mjs'), "import './gen/aaa.mjs';\nimport './gen/zzz.mjs';\nimport './util.mjs';\n");
  writeFileSync(join(repo, 'util.mjs'), 'export const u = 1;\n');
  const snap = scanTo(t, repo, ['--go', 'none']);
  const d = affected(snap, ['--changed', 'gen/zzz.mjs']);
  assert.deepEqual(d.blind, [
    { reason: 'not-in-graph', file: 'gen/zzz.mjs' },
    { reason: 'unresolved-import', file: 'main.mjs', detail: './gen/zzz.mjs' },
  ]);
});
