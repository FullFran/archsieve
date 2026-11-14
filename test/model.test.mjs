import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

const MODEL = fixture('containers', 'architecture', 'model.likec4.json');

function scanWithModel(t, model = MODEL) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', fixture('containers'), '-o', out, '--model', model]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return readJson(out);
}

const containers = (snap) => snap.nodes.filter((n) => n.kind === 'container');

test('scan --model: declared containers merge with observed units by path, and each gets a cross-check state', (t) => {
  const snap = scanWithModel(t);
  const got = containers(snap).map((n) => [n.path, n.status ?? null, n.declared?.id ?? null]);
  assert.deepEqual(got, [
    ['.', 'undeclared', null],
    ['api', 'declared-unverified', 'shop.api'],
    ['desktop', 'confirmed', 'shop.desktop'],
    ['desktop/src-tauri', null, null],
    ['packages/cli', 'confirmed', 'shop.cli'],
    ['packages/shared', 'confirmed', 'shop.shared'],
    ['svc', 'confirmed', 'shop.svc'],
    ['workers/mailer', 'declared-unverified', 'shop.mailer'],
  ]);
  const api = containers(snap).find((n) => n.path === 'api');
  assert.deepEqual(api.declared, { id: 'shop.api', title: 'API', technology: 'Node', parent: 'shop' });
  assert.deepEqual(api.evidence, [{ tool: 'likec4', file: 'architecture/model.likec4.json', detail: 'shop.api' }]);
  assert.deepEqual(snap.nodes.find((n) => n.kind === 'system'), {
    id: 'system:payments', kind: 'system', title: 'Payments provider',
    declared: { id: 'payments', title: 'Payments provider' },
    evidence: [{ tool: 'likec4', file: 'architecture/model.likec4.json', detail: 'payments' }],
  });
  assert.ok(snap.analyses.some((a) => a.tool === 'declared model' && a.status === 'ok'));
});

test('scan --model: a declared path without a manifest becomes a unit, so its imports leave the catch-all root', (t) => {
  const snap = scanWithModel(t);
  const links = snap.edges.filter((e) => e.kind === 'depends-on').map((e) => [e.source, e.target, e.status, e.relations ?? null, e.declared ?? null]);
  assert.deepEqual(links, [
    ['container:api', 'container:packages/shared', 'undeclared', { imports: 1 }, null],
    ['container:api', 'container:svc', 'declared-unverified', null, [{ title: 'spawns', technology: 'child process' }]],
    ['container:api', 'system:payments', 'declared-unverified', null, [{ title: 'charges', technology: 'HTTPS' }]],
    ['container:desktop', 'container:api', 'declared-unverified', null, [{ title: 'calls', technology: 'HTTP' }]],
    ['container:packages/cli', 'container:packages/shared', 'confirmed', { imports: 1, 'package-dependency': 1 }, [{ title: 'uses' }]],
  ]);
});

test('scan --model: the gaps become findings, never a score', (t) => {
  const snap = scanWithModel(t);
  const got = snap.findings.filter((f) => /declared|undeclared/.test(f.rule)).map((f) => [f.level, f.rule, f.subjects.join(' -> ')]).sort();
  assert.deepEqual(got, [
    ['signal', 'declared-path-missing', 'container:workers/mailer'],
    ['signal', 'undeclared-container', 'container:.'],
    ['signal', 'undeclared-link', 'container:api -> container:packages/shared'],
    ['unknown', 'declared-unverified-link', 'container:api -> container:svc'],
    ['unknown', 'declared-unverified-link', 'container:api -> system:payments'],
    ['unknown', 'declared-unverified-link', 'container:desktop -> container:api'],
  ]);
});

test('scan without --model keeps containers and links free of cross-check states', (t) => {
  const out = join(scratch(t), 'snap.json');
  assert.equal(cli(['scan', fixture('containers'), '-o', out]).code, 0);
  const snap = readJson(out);
  assert.ok(snap.nodes.every((n) => n.status === undefined && n.declared === undefined));
  assert.ok(snap.edges.every((e) => e.status === undefined));
});

test('scan --model: a file that is not a LikeC4 JSON export exits 2 with a clear error', (t) => {
  const bad = join(scratch(t), 'bad.json');
  writeFileSync(bad, JSON.stringify({ hello: 'world' }));
  const r = cli(['scan', fixture('containers'), '--model', bad]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\[BAD_INPUT\].*LikeC4/);
  assert.equal(cli(['scan', fixture('containers'), '--model', join(scratch(t), 'missing.json')]).code, 2);
});
