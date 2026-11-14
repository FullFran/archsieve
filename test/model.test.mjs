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

function renderContainers(t, extra = [], scanExtra = ['--model', MODEL]) {
  const out = join(scratch(t), 'snap.json');
  assert.equal(cli(['scan', fixture('containers'), '-o', out, ...scanExtra]).code, 0);
  const r = cli(['render', out, '--view', 'containers', ...extra]);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout;
}
const idOf = (mmd, label) => new RegExp(`^ +(n\\d+)\\["${label}`, 'm').exec(mmd)?.[1];

test('render --view containers: units grouped by declared system, each labelled with path, technology and state', (t) => {
  const mmd = renderContainers(t);
  assert.match(mmd, /^title: "Containers of containers@/m);
  assert.match(mmd, /^ {2}subgraph g\d+\["shop"\]$/m, 'declared parent becomes a boundary');
  assert.match(mmd, /^ {2}style g\d+ fill:#f6f8fa,stroke:#57606a,color:#1f2328$/m, 'the frame carries its own colours for dark themes');
  assert.match(mmd, /\["API<br\/>api · Node<br\/>declared, unverified"\]:::unverified/);
  assert.match(mmd, /\["shop<br\/>\. · node<br\/>in code, not in model"\]:::undeclared/);
  assert.match(mmd, /\["CLI<br\/>packages\/cli · Node"\]:::container/);
  assert.match(mmd, /\(\["Payments provider<br\/>external system"\]\):::external/);
  const desktop = idOf(mmd, 'Desktop app'), api = idOf(mmd, 'API'), cliN = idOf(mmd, 'CLI'), shared = idOf(mmd, 'Shared library');
  assert.match(mmd, new RegExp(`^ {2}${desktop} -\\.->\\|"calls \\(HTTP\\) · unverified"\\| ${api}$`, 'm'), 'declared-only link: dashed, marked in text');
  assert.match(mmd, new RegExp(`^ {2}${cliN} -->\\|"uses · imports, package-dependency"\\| ${shared}$`, 'm'), 'confirmed link: solid, declared and observed relations');
  assert.match(mmd, new RegExp(`^ {2}${api} -->\\|"imports · not in model"\\| ${shared}$`, 'm'));
});

test('render --view containers --format md: legend explains each state, and the view works without a model', (t) => {
  const md = renderContainers(t, ['--format', 'md']);
  assert.match(md, /^Which units run or ship, and how do they depend on each other\?$/m);
  assert.match(md, /showing 9 of 9 containers and systems/);
  for (const row of [/\| Dashed blue box \| Declared in the model, no manifest proves it/, /\| Orange box \| Found in the code, not declared in the model/,
    /\| Dashed arrow ending in `unverified` \|/, /\| Arrow ending in `not in model` \|/]) assert.match(md, row);
  const plain = renderContainers(t, [], []);
  assert.doesNotMatch(plain, /not in model|· unverified|declared, unverified|:::unverified|:::undeclared|subgraph/, 'no model, no cross-check marks');
  assert.match(plain, /\["@shop\/cli<br\/>packages\/cli · node"\]:::container/);
});

// S4 (#3): a declared runtime link (HTTP, IPC, child process, queue...) is not confirmed by imports.
function modelWith(t, patch) {
  const doc = readJson(MODEL);
  const rel = Object.values(doc.relations).find((r) => r.source.model === 'shop.cli' && r.target.model === 'shop.shared');
  Object.assign(rel, patch);
  const f = join(scratch(t), 'model.json');
  writeFileSync(f, JSON.stringify(doc));
  return f;
}
const cliLink = (snap) => snap.edges.find((e) => e.kind === 'depends-on' && e.source === 'container:packages/cli' && e.target === 'container:packages/shared');

test('S4 scan --model: a runtime technology backed only by imports is code-dependency-only, not confirmed', (t) => {
  const snap = scanWithModel(t, modelWith(t, { technology: 'HTTPS' }));
  assert.equal(cliLink(snap).status, 'code-dependency-only');
  const f = snap.findings.find((x) => x.rule === 'code-dependency-only');
  assert.equal(f.level, 'unknown');
  assert.deepEqual(f.subjects, ['container:packages/cli', 'container:packages/shared']);
  assert.match(f.message, /HTTPS/);
  assert.match(f.message, /coupled in code/);
  assert.ok(!snap.findings.some((x) => x.rule === 'declared-unverified-link' && x.subjects[0] === 'container:packages/cli'));
});

test('S4 scan --model: code technologies and the model override keep confirmed; the override can also demand runtime evidence', (t) => {
  for (const tech of ['npm package', 'library', 'import']) assert.equal(cliLink(scanWithModel(t, modelWith(t, { technology: tech }))).status, 'confirmed', tech);
  const overridden = scanWithModel(t, modelWith(t, { technology: 'HTTPS', metadata: { link: 'code' } }));
  assert.equal(cliLink(overridden).status, 'confirmed');
  assert.deepEqual(cliLink(overridden).declared, [{ title: 'uses', technology: 'HTTPS', link: 'code' }]);
  assert.equal(cliLink(scanWithModel(t, modelWith(t, { metadata: { link: 'runtime' } }))).status, 'code-dependency-only');
  assert.equal(cliLink(scanWithModel(t, modelWith(t, { technology: 'Message bus' }))).status, 'code-dependency-only', 'an unrecognised technology needs its own evidence');
});

test('S4 render --view containers: a code-dependency-only link says so in words', (t) => {
  const out = join(scratch(t), 'snap.json');
  assert.equal(cli(['scan', fixture('containers'), '-o', out, '--model', modelWith(t, { technology: 'HTTPS' })]).code, 0);
  const md = cli(['render', out, '--view', 'containers', '--format', 'md']).stdout;
  assert.match(md, /\|"uses \(HTTPS\) · imports, package-dependency · code only, runtime unverified"\|/);
  assert.match(md, /\| Arrow ending in `code only, runtime unverified` \|/);
});
