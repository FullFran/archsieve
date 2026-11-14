import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync } from 'node:fs';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

// fixtures/entry-points: a test imports every production file. All of them but legacy/old.mjs are
// run some other way: package.json scripts (root and nested), a Dockerfile CMD, a systemd unit, a
// Procfile, a shell and a PowerShell script, a GitHub workflow `run:` line, and a spawn by path.
function scanEp(t) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', fixture('entry-points'), '--go', 'none', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return readJson(out);
}

test('S21 scan: files run by scripts, commands, service units or a spawn by path are entry points, not test-only', (t) => {
  const snap = scanEp(t);
  assert.deepEqual(snap.findings.filter((f) => f.rule === 'test-only-module').map((f) => f.subjects), [['legacy/old.mjs']]);
});

test('S21 scan: every suppressed candidate says why, with the file and line that runs it', (t) => {
  const snap = scanEp(t);
  assert.deepEqual(snap.suppressed.map((s) => [s.rule, s.subject, s.reason, `${s.evidence.file}:${s.evidence.line ?? ''}`]), [
    ['test-only-module', 'jobs/child.mjs', 'spawned by path', 'src/index.mjs:4'],
    ['test-only-module', 'packages/tool/bin/run.mjs', 'package.json script', 'packages/tool/package.json:5'],
    ['test-only-module', 'scripts/build.mjs', 'package.json script', 'package.json:7'],
    ['test-only-module', 'server/main.mjs', 'Dockerfile command', 'Dockerfile:4'],
    ['test-only-module', 'src/dev.mjs', 'package.json script', 'package.json:8'],
    ['test-only-module', 'src/index.mjs', 'manifest entry', 'package.json:5'],
    ['test-only-module', 'tools/migrate.mjs', 'shell script', 'deploy/run.sh:3'],
    ['test-only-module', 'tools/report.mjs', 'workflow run step', '.github/workflows/ci.yml:8'],
    ['test-only-module', 'tools/seed.mjs', 'shell script', 'deploy/run.ps1:1'],
    ['test-only-module', 'web/serve.mjs', 'Procfile', 'Procfile:1'],
    ['test-only-module', 'worker/index.mjs', 'systemd unit', 'deploy/worker.service:5'],
  ]);
  assert.equal(snap.suppressed.find((s) => s.subject === 'scripts/build.mjs').evidence.detail, 'scripts.build: node scripts/build.mjs --out dist');
});

test('S21 scan: a program spawned through process.execPath is node, not an unresolved call', (t) => {
  const snap = scanEp(t);
  assert.deepEqual(snap.findings.filter((f) => f.rule === 'runtime-call-unresolved').map((f) => f.subjects), []);
});

test('S21 scan: nested in a monorepo, spawn paths resolve from the container and deployed paths prefer the nearest match', (t) => {
  // The fixture one folder down, next to another project that also has worker/index.mjs.
  const repo = scratch(t);
  cpSync(fixture('entry-points'), join(repo, 'a'), { recursive: true });
  cpSync(fixture('runtime-links'), join(repo, 'b'), { recursive: true });
  const out = join(scratch(t), 'snap.json');
  assert.equal(cli(['scan', repo, '--go', 'none', '-o', out]).code, 0);
  const snap = readJson(out);
  assert.deepEqual(snap.findings.filter((f) => f.rule === 'test-only-module' && f.subjects[0].startsWith('a/')).map((f) => f.subjects), [['a/legacy/old.mjs']]);
  assert.deepEqual(['a/jobs/child.mjs', 'a/worker/index.mjs'].map((f) => snap.suppressed.find((s) => s.subject === f)?.reason), ['spawned by path', 'systemd unit']);
});
