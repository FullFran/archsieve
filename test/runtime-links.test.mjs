import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

// fixtures/runtime-links: launcher/main.mjs spawns node on worker/index.mjs (through a const), runs
// the bin 'svc-bin' of tool/, runs git (outside the repository) and a program from the environment.
function scanRt(t, extra = []) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', fixture('runtime-links'), '--go', 'none', '-o', out, ...extra]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return { file: out, snap: readJson(out) };
}
const runtime = (snap) => snap.edges.filter((e) => e.kind === 'runtime-link');

test('S6 scan: child-process calls with a literal or const program become runtime links, with file:line, at pattern confidence', (t) => {
  const { snap } = scanRt(t);
  assert.deepEqual(runtime(snap).map((e) => [e.source, e.target, e.relations, e.confidence]), [
    ['container:launcher', 'container:tool', { 'child-process': 1 }, 'pattern'],
    ['container:launcher', 'container:worker', { 'child-process': 1 }, 'pattern'],
  ]);
  assert.deepEqual(runtime(snap)[1].evidence, [{ tool: 'archsieve patterns', file: 'launcher/main.mjs', line: 3, detail: "spawn('node', [WORKER], { stdio: 'pipe' });" }]);
  assert.ok(!snap.edges.some((e) => e.kind === 'depends-on' && e.target === 'container:worker'), 'a runtime link is not a code dependency');
});

test('S6 scan: a call site whose program cannot be resolved is unknown; programs outside the repository are only counted', (t) => {
  const { snap } = scanRt(t);
  const u = snap.findings.filter((f) => f.rule === 'runtime-call-unresolved');
  assert.deepEqual(u.map((f) => [f.level, f.subjects[0], f.evidence.map((e) => e.line)]), [['unknown', 'launcher/main.mjs', [6]]]);
  assert.ok(!JSON.stringify(snap.findings).includes("'git'"));
  assert.match(snap.analyses.find((a) => a.tool === 'archsieve patterns').note, /2 runtime links, 1 call site to programs outside the repository, 1 unresolved/);
});

test('S6 scan --model: a declared child-process link with pattern evidence is evidenced; a declared HTTP link is not', (t) => {
  const { snap } = scanRt(t, ['--model', fixture('runtime-links', 'architecture', 'model.likec4.json')]);
  const status = (target) => snap.edges.find((e) => e.kind === 'depends-on' && e.source === 'container:launcher' && e.target === target).status;
  assert.equal(status('container:worker'), 'evidenced');
  assert.equal(status('container:tool'), 'declared-unverified', 'child-process evidence does not prove an HTTP link');
  assert.ok(!snap.findings.some((f) => f.rule === 'declared-unverified-link' && f.subjects[1] === 'container:worker'));
});

test('S6 render --view containers: runtime evidence is drawn and named as a static pattern', (t) => {
  const { file } = scanRt(t, ['--model', fixture('runtime-links', 'architecture', 'model.likec4.json')]);
  const md = cli(['render', file, '--view', 'containers', '--format', 'md']).stdout;
  assert.match(md, /\|"runs \(stdio\) · child-process \(static pattern\) · evidenced \(static pattern\)"\|/);
  assert.match(md, /\| `child-process \(static pattern\)` \|/);
  const plain = cli(['render', scanRt(t).file, '--view', 'containers']).stdout;
  assert.match(plain, /-\.->\|"child-process \(static pattern\)"\|/, 'without a model, pattern evidence is a dashed arrow');
});

test('S6 scan --no-units skips the runtime patterns', (t) => {
  const { snap } = scanRt(t, ['--no-units']);
  assert.deepEqual(runtime(snap), []);
  assert.ok(!snap.analyses.some((a) => a.tool === 'archsieve patterns'));
});
