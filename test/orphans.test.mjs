import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

// fixtures/orphans: a test imports src/a/x.mjs, which imports src/b/z.mjs; src/index.mjs (main) and
// scripts/gen.mjs (an npm script) import nothing and nothing imports them; src/dead.mjs neither.
function scanOrphans(t) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', fixture('orphans'), '--go', 'none', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return readJson(out);
}

test('S22 scan: a file only test-only code imports is test-only-dependency, never "imported only by tests (0 test files)"', (t) => {
  const snap = scanOrphans(t);
  const rules = snap.findings.filter((f) => f.rule.startsWith('test-only')).map((f) => [f.rule, ...f.subjects]);
  assert.deepEqual(rules, [['test-only-dependency', 'src/b/z.mjs'], ['test-only-module', 'src/a/x.mjs']]);
  const dep = snap.findings.find((f) => f.rule === 'test-only-dependency');
  assert.match(dep.message, /^src\/b\/: 1 production file \(1 line\) is imported only by test-only code \(src\/a\/x\.mjs\)/);
  assert.doesNotMatch(dep.message, /0 test files/);
  assert.deepEqual(dep.evidence, [{ tool: 'archsieve', file: 'src/a/x.mjs', detail: 'imports src/b/z.mjs' }]);
});

test('S22 scan: no-orphans leaves out entry points and lists them as suppressed', (t) => {
  const snap = scanOrphans(t);
  assert.deepEqual(snap.findings.filter((f) => f.rule === 'no-orphans').map((f) => f.subjects), [['src/dead.mjs']]);
  assert.deepEqual(snap.suppressed.filter((s) => s.rule === 'no-orphans').map((s) => [s.subject, s.reason]), [
    ['scripts/gen.mjs', 'package.json script'],
    ['src/index.mjs', 'manifest entry'],
  ]);
});
