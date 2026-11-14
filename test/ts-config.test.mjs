import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

// fixtures/ts-alias: web/src/app.ts imports '@/lib/util' and '@/lib/format'; web/tsconfig.json
// (JSONC) maps '@/*' to 'src/*'; the root tsconfig.json has no paths.
function scanAlias(t, extra = [], dir = fixture('ts-alias')) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', dir, '--go', 'none', '--no-units', '-o', out, ...extra]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0);
  return readJson(out);
}

const rules = (snap, rule) => snap.findings.filter((f) => f.rule === rule);

test('S3 scan: unresolved imports that match tsconfig paths get a hint naming the exact --ts-config flag', (t) => {
  const snap = scanAlias(t);
  const [unresolved] = rules(snap, 'unresolved-import');
  assert.deepEqual(unresolved.evidence.map((e) => e.detail), ['@/lib/format', '@/lib/util'], 'every unresolved specifier of a file is kept');
  assert.match(unresolved.message, /2 imports "@\/lib\/format", "@\/lib\/util" could not be resolved/);
  const hints = rules(snap, 'ts-config-hint');
  assert.equal(hints.length, 1);
  assert.equal(hints[0].level, 'signal');
  assert.deepEqual(hints[0].subjects, ['web/tsconfig.json']);
  assert.match(hints[0].message, /2 unresolved imports match compilerOptions\.paths "@\/\*" in web\/tsconfig\.json/);
  assert.match(hints[0].message, /--ts-config web\/tsconfig\.json/);
  assert.deepEqual(hints[0].evidence.map((e) => e.file), ['web/src/app.ts', 'web/tsconfig.json']);
});

test('S3 scan: --ts-config auto uses the only tsconfig whose paths match, and says so', (t) => {
  const snap = scanAlias(t, ['--ts-config', 'auto']);
  assert.equal(rules(snap, 'unresolved-import').length, 0);
  assert.equal(rules(snap, 'ts-config-hint').length, 0);
  assert.ok(snap.edges.some((e) => e.source === 'web/src/app.ts' && e.target === 'web/src/lib/util.ts'));
  const a = snap.analyses.find((x) => x.tool === 'dependency-cruiser');
  assert.match(a.note, /--ts-config auto: web\/tsconfig\.json/);
});

test('S3 scan: an explicit --ts-config resolves the aliases and leaves no hint', (t) => {
  const snap = scanAlias(t, ['--ts-config', 'web/tsconfig.json']);
  assert.equal(rules(snap, 'unresolved-import').length, 0);
  assert.equal(rules(snap, 'ts-config-hint').length, 0);
});

test('S3 scan: with two matching tsconfigs auto picks none and both hints stay', (t) => {
  const repo = join(scratch(t), 'repo');
  cpSync(fixture('ts-alias'), repo, { recursive: true });
  mkdirSync(join(repo, 'admin', 'src'), { recursive: true });
  writeFileSync(join(repo, 'admin', 'tsconfig.base.json'), '{ "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["src/*"] } } }\n');
  writeFileSync(join(repo, 'admin', 'tsconfig.json'), '{ "extends": "./tsconfig.base.json" }\n');
  writeFileSync(join(repo, 'admin', 'src', 'main.ts'), "import { x } from '~/x';\nexport const m = x;\n");
  writeFileSync(join(repo, 'admin', 'src', 'x.ts'), 'export const x = 1;\n');
  const snap = scanAlias(t, ['--ts-config', 'auto'], repo);
  assert.deepEqual(rules(snap, 'ts-config-hint').map((f) => f.subjects[0]), ['admin/tsconfig.base.json', 'admin/tsconfig.json', 'web/tsconfig.json']);
  assert.deepEqual(rules(snap, 'unresolved-import').map((f) => f.subjects[0]), ['admin/src/main.ts', 'web/src/app.ts']);
  assert.match(snap.analyses.find((x) => x.tool === 'dependency-cruiser').note, /--ts-config auto: ambiguous/);
});
