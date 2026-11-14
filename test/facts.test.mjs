import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, writeFileSync, rmSync } from 'node:fs';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

// fixtures/facts: web (package.json with 2 dependencies and 1 dev dependency, a lockfile, two
// TypeScript files, a Dockerfile) and core (go.mod with 2 direct and 1 indirect requirements, go.sum,
// a Go file, a PowerShell script). README.md at the root belongs to no container.
function scanFacts(t, dir = fixture('facts')) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', dir, '--go', 'none', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return { file: out, snap: readJson(out) };
}
const factsOf = (snap, path) => snap.nodes.find((n) => n.kind === 'container' && n.path === path).facts;

test('S8 scan: each container gets files and lines per language, manifests with dependency counts, and toolchains with the file that implies them', (t) => {
  const { snap } = scanFacts(t);
  assert.deepEqual(factsOf(snap, 'web'), {
    files: 4, lines: 12,
    languages: { dockerfile: { files: 1, lines: 2 }, json: { files: 1, lines: 5 }, typescript: { files: 2, lines: 5 } },
    manifests: [
      { file: 'web/package-lock.json', kind: 'lockfile' },
      { file: 'web/package.json', kind: 'package.json', dependencies: 2, devDependencies: 1 },
    ],
    toolchains: [{ name: 'docker', file: 'web/Dockerfile' }, { name: 'node', file: 'web/package.json' }],
  });
  assert.deepEqual(factsOf(snap, 'core').manifests, [
    { file: 'core/go.mod', kind: 'go.mod', dependencies: 2, indirect: 1 },
    { file: 'core/go.sum', kind: 'lockfile' },
  ]);
  assert.deepEqual(factsOf(snap, 'core').toolchains, [{ name: 'go', file: 'core/go.mod' }, { name: 'powershell', file: 'core/scripts/build.ps1' }]);
  assert.match(snap.analyses.find((a) => a.tool === 'container facts').note, /1 file outside every container/);
});

test('S8 render --view containers --format md: a facts table follows the diagram', (t) => {
  const { file } = scanFacts(t);
  const md = cli(['render', file, '--view', 'containers', '--format', 'md']).stdout;
  assert.match(md, /\*\*Container facts\*\*/);
  assert.match(md, /\| web \| 4 \| 12 \| json 5, typescript 5, dockerfile 2 \| package.json \(2 deps, 1 dev\), package-lock.json \| docker, node \|/);
  assert.match(md, /\| core \| 3 \| 14 \| go 13, powershell 1 \| go.mod \(2 deps, 1 indirect\), go.sum \| go, powershell \|/);
});

test('S8 diff: changes in container facts are listed, unchanged containers are not', (t) => {
  const before = scanFacts(t);
  const repo = join(scratch(t), 'repo');
  cpSync(fixture('facts'), repo, { recursive: true });
  rmSync(join(repo, 'web', 'Dockerfile'));
  writeFileSync(join(repo, 'web', 'src', 'c.ts'), 'export const c = 1;\n');
  const after = scanFacts(t, repo);
  const out = join(scratch(t), 'd.json');
  assert.equal(cli(['diff', before.file, after.file, '-o', out]).code, 0);
  assert.equal(cli(['validate', out]).code, 0);
  assert.deepEqual(readJson(out).containerFacts, [
    { id: 'container:web', files: { before: 4, after: 4 }, lines: { before: 12, after: 11 }, dependencies: { before: 3, after: 3 }, toolchains: { added: [], removed: ['docker'] } },
  ]);
  const md = cli(['diff', before.file, after.file, '--format', 'md']).stdout;
  assert.match(md, /## Container facts/);
  assert.match(md, /\| web \| 4 \| 11 \(-1\) \| 3 \| removed: docker \|/);
});
