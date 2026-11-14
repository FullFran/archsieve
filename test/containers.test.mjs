import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

function scanContainers(t, extra = []) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', fixture('containers'), '-o', out, ...extra]);
  assert.equal(r.code, 0, r.stderr);
  return readJson(out);
}

const units = (snap) => snap.nodes.filter((n) => n.kind === 'container');

test('scan: every manifest becomes an observed unit, with its technology and the file that proves it', (t) => {
  const snap = scanContainers(t);
  const got = units(snap).map((n) => [n.path, n.title, n.technology.join('+'), n.runnable]);
  assert.deepEqual(got, [
    ['.', 'shop', 'node', true],
    ['desktop', 'shop-desktop', 'node', false],
    ['desktop/src-tauri', 'shop-desktop', 'rust+tauri', true],
    ['packages/cli', '@shop/cli', 'node', true],
    ['packages/shared', '@shop/shared', 'node', false],
    ['svc', 'example.com/svc', 'go', true],
  ]);
  const byPath = new Map(units(snap).map((n) => [n.path, n]));
  assert.deepEqual(byPath.get('.').id, 'container:.');
  assert.deepEqual(byPath.get('packages/cli').evidence, [{ tool: 'manifest', file: 'packages/cli/package.json', detail: 'bin' }]);
  assert.deepEqual(byPath.get('.').evidence, [{ tool: 'manifest', file: 'package.json', detail: 'scripts.start' }]);
  assert.deepEqual(byPath.get('desktop/src-tauri').evidence.map((e) => `${e.tool}:${e.file}:${e.detail ?? ''}`), [
    'cargo metadata:desktop/src-tauri/Cargo.toml:bin shop-desktop',
    'manifest:desktop/src-tauri/tauri.conf.json:',
  ]);
  assert.deepEqual(byPath.get('svc').evidence, [{ tool: 'go list', file: 'svc', detail: 'package main' }, { tool: 'manifest', file: 'svc/go.mod' }]);
  assert.ok(snap.analyses.some((a) => a.tool === 'manifests' && a.status === 'ok'));
  assert.ok(snap.analyses.some((a) => a.tool === 'cargo metadata' && a.status === 'ok'));
});

test('scan: --no-units skips the container analysis', (t) => {
  const snap = scanContainers(t, ['--no-units']);
  assert.deepEqual(units(snap), []);
  assert.ok(!snap.analyses.some((a) => a.tool === 'manifests'));
});

test('scan: without cargo the Rust units are reported as skipped, never guessed', (t) => {
  const out = join(scratch(t), 'snap.json');
  const env = { ...process.env, PATH: process.env.PATH.split(':').filter((d) => !/cargo/.test(d)).join(':') };
  const r = cli(['scan', fixture('containers'), '-o', out, '--go', 'none'], { env });
  assert.equal(r.code, 0, r.stderr);
  const snap = readJson(out);
  const tauri = units(snap).find((n) => n.path === 'desktop/src-tauri');
  assert.deepEqual(tauri.technology, ['tauri'], 'tauri.conf.json is still read as data');
  assert.equal(tauri.runnable, false, 'no bin target can be proven without cargo');
  assert.ok(snap.analyses.some((a) => a.tool === 'cargo metadata' && a.status === 'skipped'));
});
