import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { cli, scratch, readJson } from './helpers.mjs';

// node_modules cannot be committed (it is git-ignored), so the installed packages are written per test.
function write(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
}

function exportsFixture(t) {
  const root = join(scratch(t), 'app');
  write(root, {
    'package.json': { name: 'app', bin: 'src/main.ts' },
    'node_modules/withmain/package.json': { name: 'withmain', main: 'index.js' },
    'node_modules/withmain/index.js': 'export const m = 1;\n',
    // Conditional "." export, no main.
    'node_modules/exp-only/package.json': { name: 'exp-only', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } },
    'node_modules/exp-only/dist/index.js': 'export const a = 1;\n',
    // Explicit subpath and wildcard subpath with conditions.
    'node_modules/wild/package.json': { name: 'wild', exports: { './sub': './dist/sub.js', './*': { import: './dist/esm/*' } } },
    'node_modules/wild/dist/sub.js': 'export const b = 1;\n',
    'node_modules/wild/dist/esm/x.js': 'export const c = 1;\n',
    // Scoped, exports only, import/require conditions on a subpath.
    'node_modules/@scope/lib/package.json': { name: '@scope/lib', type: 'module', exports: { '.': { import: './build/index.mjs', require: './build/index.cjs' }, './value': { import: './build/value.mjs' } } },
    'node_modules/@scope/lib/build/index.mjs': 'export const d = 1;\n',
    'node_modules/@scope/lib/build/value.mjs': 'export const e = 1;\n',
    // pnpm layout: the package lives in the virtual store, node_modules/<name> is a symlink.
    'node_modules/.pnpm/linked@1.0.0/node_modules/linked/package.json': { name: 'linked', exports: { '.': { import: './esm/index.js' } } },
    'node_modules/.pnpm/linked@1.0.0/node_modules/linked/esm/index.js': 'export const f = 1;\n',
    // Installed, but the exports target is not built: the package is still the dependency.
    'node_modules/unbuilt/package.json': { name: 'unbuilt', exports: { '.': './dist/index.js' } },
    'src/main.ts': [
      'import { m } from "withmain";',
      'import { a } from "exp-only";',
      'import { b } from "wild/sub";',
      'import { c } from "wild/x.js";',
      'import { d } from "@scope/lib";',
      'import { e } from "@scope/lib/value";',
      'import { f } from "linked";',
      'import { g } from "unbuilt";',
      'import { h } from "not-installed";',
      'console.log(m, a, b, c, d, e, f, g, h);',
      '',
    ].join('\n'),
  });
  symlinkSync('.pnpm/linked@1.0.0/node_modules/linked', join(root, 'node_modules', 'linked'));
  return root;
}

test('packages that declare only an exports map resolve to npm nodes; a package that is not installed stays unknown (#30)', (t) => {
  const root = exportsFixture(t);
  const out = join(root, '..', 's.json');
  const r = cli(['scan', root, '--no-units', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /findings: 0 error, \d+ signal, 1 unknown/);
  const snap = readJson(out);
  const pkgs = ['@scope/lib', 'exp-only', 'linked', 'unbuilt', 'wild', 'withmain'];
  assert.deepEqual(snap.nodes.filter((n) => n.kind === 'external-package').map((n) => n.id), pkgs.map((p) => `npm:${p}`));
  const targets = snap.edges.filter((e) => e.source === 'src/main.ts' && e.kind === 'imports').map((e) => e.target).sort();
  assert.deepEqual(targets, pkgs.map((p) => `npm:${p}`));
  const specifiers = snap.edges.filter((e) => e.source === 'src/main.ts').flatMap((e) => e.evidence.map((x) => x.detail)).sort();
  assert.deepEqual(specifiers, ['@scope/lib', '@scope/lib/value', 'exp-only', 'linked', 'unbuilt', 'wild/sub', 'wild/x.js', 'withmain']);
  assert.ok(!snap.nodes.some((n) => n.id.includes('.pnpm')), 'the pnpm virtual store is not a package name');
  const unknown = snap.findings.filter((f) => f.level === 'unknown');
  assert.deepEqual(unknown.map((f) => [f.rule, f.subjects, f.evidence.map((e) => e.detail)]), [['unresolved-import', ['src/main.ts'], ['not-installed']]]);
  assert.equal(cli(['validate', out]).code, 0);
});
