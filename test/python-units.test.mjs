import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cli, scratch, fixture, readJson } from './helpers.mjs';
import { parseToml } from '../src/adapters/toml.mjs';

// fixtures/python-units: a virtual uv workspace root (not a unit), a PEP 621 worker with scripts and
// uv.lock, a poetry API, a library with no way to run, a service started by a Dockerfile CMD and a
// package with a __main__.py.
function scanPy(t) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', fixture('python-units'), '--go', 'none', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return readJson(out);
}

test('S7 scan: a pyproject.toml with a project table is a python container; a tool-only root is not', (t) => {
  const snap = scanPy(t);
  const units = snap.nodes.filter((n) => n.kind === 'container');
  assert.deepEqual(units.map((u) => [u.path, u.title, u.technology.join('+'), u.runnable]), [
    ['cli', 'tool-cli', 'python', true],
    ['lib', 'shared-lib', 'python', false],
    ['poetry-api', 'poetry-api', 'python', true],
    ['web-api', 'web-api', 'python', true],
    ['worker', 'orders-worker', 'python', true],
  ]);
  const ev = (p) => units.find((u) => u.path === p).evidence;
  assert.deepEqual(ev('worker'), [{ tool: 'manifest', file: 'worker/pyproject.toml', detail: 'project.scripts' }]);
  assert.deepEqual(ev('poetry-api'), [{ tool: 'manifest', file: 'poetry-api/pyproject.toml', detail: 'tool.poetry.scripts' }]);
  assert.deepEqual(ev('web-api'), [{ tool: 'manifest', file: 'web-api/pyproject.toml', detail: 'Dockerfile CMD' }]);
  assert.deepEqual(ev('cli'), [{ tool: 'manifest', file: 'cli/pyproject.toml', detail: '__main__.py' }]);
  assert.deepEqual(ev('lib'), [{ tool: 'manifest', file: 'lib/pyproject.toml' }]);
});

test('S7 scan: python containers carry dependency counts and their lockfile in facts', (t) => {
  const snap = scanPy(t);
  const facts = (p) => snap.nodes.find((n) => n.id === `container:${p}`).facts;
  const worker = facts('worker');
  assert.deepEqual(worker.manifests, [
    { file: 'worker/pyproject.toml', kind: 'pyproject.toml', dependencies: 4, devDependencies: 3 },
    { file: 'worker/uv.lock', kind: 'lockfile' },
  ]);
  assert.equal(worker.languages.python.files, 1);
  assert.deepEqual(worker.toolchains.find((x) => x.name === 'python').file, 'worker/pyproject.toml');
  assert.deepEqual(facts('poetry-api').manifests, [
    { file: 'poetry-api/poetry.lock', kind: 'lockfile' },
    { file: 'poetry-api/pyproject.toml', kind: 'pyproject.toml', dependencies: 2, devDependencies: 1 },
  ]);
  assert.equal(facts('lib').manifests[0].dependencies, 0);
  assert.equal(snap.nodes.some((n) => n.id === 'container:.'), false);
});

test('S7 toml: the reader handles tables, arrays, inline tables, comments and multi-line values', () => {
  const doc = parseToml(`
# c
title = "a # not a comment"
[a.b]
list = [
  "x", # trailing ] comment
  'y',
]
inline = { version = "^2", optional = true }
[[a.c]]
n = 1
[[a.c]]
n = 2
text = """
multi ] line
"""
"quoted key".dotted.key = false
`);
  assert.equal(doc.title, 'a # not a comment');
  assert.deepEqual(doc.a.b.list, ['x', 'y']);
  assert.deepEqual(doc.a.b.inline, { version: '^2', optional: true });
  assert.deepEqual(doc.a.c.map((c) => c.n), [1, 2]);
  assert.equal(doc.a.c[1].text.trim(), 'multi ] line');
  assert.equal(doc.a.c[1]['quoted key'].dotted.key, false);
  assert.throws(() => parseToml('a = [1, 2'));
});
