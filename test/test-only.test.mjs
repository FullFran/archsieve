import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync } from 'node:fs';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

// fixtures/test-only: src/old/** (4 files importing each other) is imported only by a test;
// src/util/testkit.mjs only by a test, next to src/util/helper.mjs that production also imports;
// src/cli.mjs (bin) and src/pub/public.mjs (exports) are entry points that only tests import.
function scanTo(t, extra = []) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', fixture('test-only'), '--go', 'none', '-o', out, ...extra]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return readJson(out);
}
const testOnly = (snap) => snap.findings.filter((f) => f.rule === 'test-only-module');

test('S9 scan: production files that only tests (or other such files) import are one signal per retired folder, with its size', (t) => {
  const got = testOnly(scanTo(t));
  assert.deepEqual(got.map((f) => [f.level, f.subjects]), [
    ['signal', ['src/old/a.mjs', 'src/old/b.mjs', 'src/old/c.mjs', 'src/old/deep/d.mjs']],
    ['signal', ['src/util/testkit.mjs']],
  ]);
  assert.match(got[0].message, /^src\/old\/: 4 production files \(8 lines\) are imported only by tests \(1 test file\)/);
  assert.match(got[0].message, /loaded by path at runtime/);
  assert.deepEqual(got[0].evidence, [{ tool: 'archsieve', file: 'test/old.test.mjs', detail: 'imports src/old/a.mjs' }, { tool: 'archsieve', file: 'test/old.test.mjs', detail: 'imports src/old/c.mjs' }]);
  assert.match(got[1].message, /^src\/util\/testkit\.mjs: 1 production file \(1 line\)/);
});

test('S9 scan: manifest entry points are never test-only; --entry-globs adds entry points', (t) => {
  const subjects = testOnly(scanTo(t)).flatMap((f) => f.subjects);
  for (const entry of ['src/cli.mjs', 'src/pub/public.mjs', 'src/index.mjs']) assert.ok(!subjects.includes(entry), entry);
  const withGlobs = testOnly(scanTo(t, ['--entry-globs', 'src/util/testkit.mjs']));
  assert.deepEqual(withGlobs.map((f) => f.subjects[0]), ['src/old/a.mjs']);
});

test('S9 scan: groups stop at container boundaries; without test files the analysis says it was skipped', (t) => {
  // test-split nested one folder down: its two containers share a parent that is not the root.
  const repo = scratch(t);
  cpSync(fixture('test-split'), join(repo, 'group'), { recursive: true });
  const out = join(scratch(t), 'snap.json');
  assert.equal(cli(['scan', repo, '--go', 'none', '-o', out]).code, 0);
  const groups = readJson(out).findings.filter((f) => f.rule === 'test-only-module').map((f) => f.subjects);
  assert.deepEqual(groups, [['group/app/src/main.mjs'], ['group/lib/src/core.mjs', 'group/lib/src/fixtures.mjs']]);
  const plain = join(scratch(t), 'plain.json');
  assert.equal(cli(['scan', fixture('test-split'), '--go', 'none', '--test-globs', 'nothing/**', '-o', plain]).code, 0);
  const a = readJson(plain).analyses.find((x) => x.tool === 'test-only modules');
  assert.deepEqual([a.status, a.note], ['skipped', 'no test files matched the test globs']);
});
