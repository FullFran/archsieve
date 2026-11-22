import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cli, scratch, readJson } from './helpers.mjs';

// A synthetic repository with three units (a, b, c) and a fixed commit history:
// a/x.mjs imports c/y.mjs; a and b change together with no import between them.
const DAY = 86400;
const T0 = 1700000000;
function historyRepo(t) {
  const repo = join(scratch(t), 'repo');
  for (const u of ['a', 'b', 'c']) {
    mkdirSync(join(repo, u), { recursive: true });
    writeFileSync(join(repo, u, 'package.json'), JSON.stringify({ name: `@h/${u}` }));
  }
  writeFileSync(join(repo, 'a', 'x.mjs'), "import { y } from '../c/y.mjs';\nexport const x = y;\n");
  writeFileSync(join(repo, 'b', 'z.mjs'), 'export const z = 0;\n');
  writeFileSync(join(repo, 'c', 'y.mjs'), 'export const y = 0;\n');
  const git = (args, when) => {
    const date = `@${when} +0000`;
    const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    assert.equal(r.status, 0, r.stderr);
  };
  const touch = (...files) => { for (const f of files) writeFileSync(join(repo, f), `${readFileSync(join(repo, f), 'utf8')}// ${Math.random()}\n`); };
  git(['init', '-q'], T0);
  git(['add', '.'], T0);
  git(['commit', '-qm', 'initial'], T0); // day 0: touches every file, outside a 30-day window
  let day = 100;
  const commit = (...files) => { touch(...files); git(['commit', '-qam', `c${day}`], T0 + day++ * DAY); };
  for (let i = 0; i < 4; i++) commit('a/x.mjs', 'b/z.mjs'); // a+b: no import between them
  for (let i = 0; i < 4; i++) commit('a/x.mjs', 'c/y.mjs'); // a+c: a imports c
  commit('b/z.mjs');
  return repo;
}

function scanHistory(t, repo, extra = []) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', repo, '--go', 'none', '--history', '--since', '30d', '--co-change-min', '3', '-o', out, ...extra]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return { file: out, snap: readJson(out) };
}

test('S5 scan --history: churn per file and per container over a window anchored at HEAD', (t) => {
  const { snap } = scanHistory(t, historyRepo(t));
  const churn = (id) => snap.nodes.find((n) => n.id === id).churn;
  assert.equal(churn('a/x.mjs'), 8);
  assert.equal(churn('b/z.mjs'), 5);
  assert.equal(churn('c/y.mjs'), 4);
  assert.equal(churn('container:a'), 8);
  assert.equal(churn('container:b'), 5);
  const a = snap.analyses.find((x) => x.tool === 'git log');
  assert.equal(a.status, 'ok');
  assert.match(a.note, /9 commits since 2024-01-31T22:13:20Z/, 'the window is anchored at the HEAD commit date and written out');
});

test('S5 scan --history: co-change across containers with no static link is a signal; with a link it is not', (t) => {
  const { snap } = scanHistory(t, historyRepo(t));
  const co = snap.findings.filter((f) => f.rule === 'co-change-without-link');
  assert.deepEqual(co.map((f) => [f.level, ...f.subjects]), [['signal', 'container:a', 'container:b']]);
  assert.match(co[0].message, /4 commits/);
  assert.ok(!snap.findings.some((f) => f.level === 'error' && /co-change/.test(f.rule)), 'history never yields errors');
});

test('S5 scan --history: the same commit gives byte-identical snapshots; without --history nothing changes', (t) => {
  const repo = historyRepo(t);
  const a = scanHistory(t, repo), b = scanHistory(t, repo);
  assert.equal(readFileSync(a.file, 'utf8'), readFileSync(b.file, 'utf8'));
  const out = join(scratch(t), 'plain.json');
  assert.equal(cli(['scan', repo, '--go', 'none', '-o', out]).code, 0);
  const plain = readJson(out);
  assert.ok(plain.nodes.every((n) => n.churn === undefined));
  assert.ok(!plain.analyses.some((x) => x.tool === 'git log'));
});

test('S5 scan --history --ref reads the history of that commit, not of the working tree', (t) => {
  const repo = historyRepo(t);
  const { snap } = scanHistory(t, repo, ['--ref', 'HEAD~1']);
  assert.equal(snap.nodes.find((n) => n.id === 'b/z.mjs').churn, 4, 'the last commit (b only) is after HEAD~1');
});

// #39: a root package plus a, b and c. Docs, an image and the lockfile change with a and b;
// a root script changes with c. Only the script is coupling.
function rootNoiseRepo(t) {
  const repo = join(scratch(t), 'repo');
  writeFileSync(join(mkdirP(repo), 'package.json'), JSON.stringify({ name: 'root', private: true }));
  for (const u of ['a', 'b', 'c']) writeFileSync(join(mkdirP(join(repo, u)), 'package.json'), JSON.stringify({ name: `@h/${u}` }));
  for (const [f, body] of [['a/x.mjs', 'export const x = 0;\n'], ['b/z.mjs', 'export const z = 0;\n'], ['c/y.mjs', 'export const y = 0;\n'],
    ['README.md', '# r\n'], ['docs/adr.md', '# adr\n'], ['docs/diagram.png', 'png\n'], ['pnpm-lock.yaml', 'lockfileVersion: 9\n'], ['scripts/deploy.sh', 'echo\n']]) {
    mkdirP(join(repo, f, '..'));
    writeFileSync(join(repo, f), body);
  }
  const git = (args, when) => {
    const date = `@${when} +0000`;
    const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    assert.equal(r.status, 0, r.stderr);
  };
  git(['init', '-q'], T0);
  git(['add', '.'], T0);
  git(['commit', '-qm', 'initial'], T0);
  let day = 100;
  const commit = (...files) => {
    for (const f of files) writeFileSync(join(repo, f), `${readFileSync(join(repo, f), 'utf8')}x\n`);
    git(['commit', '-qam', `c${day}`], T0 + day++ * DAY);
  };
  for (let i = 0; i < 4; i++) commit('a/x.mjs', 'README.md', 'docs/adr.md');
  for (let i = 0; i < 4; i++) commit('b/z.mjs', 'pnpm-lock.yaml', 'docs/diagram.png');
  for (let i = 0; i < 4; i++) commit('c/y.mjs', 'scripts/deploy.sh');
  return repo;
}
function mkdirP(dir) { mkdirSync(dir, { recursive: true }); return dir; }

test('#39 scan --history: docs, images and lockfiles are not co-change coupling; a root script still is', (t) => {
  const { snap } = scanHistory(t, rootNoiseRepo(t));
  const co = snap.findings.filter((f) => f.rule === 'co-change-without-link');
  assert.deepEqual(co.map((f) => f.subjects), [['container:.', 'container:c']]);
  const churn = (id) => snap.nodes.find((n) => n.id === id).churn;
  assert.equal(churn('container:.'), 4, 'only the commits that touched the root script count for the root');
  assert.equal(churn('container:a'), 4);
  assert.equal(churn('a/x.mjs'), 4, 'file churn is unchanged');
});

test('S5 scan --history outside a git checkout is skipped, never guessed', (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
  const out = join(scratch(t), 's.json');
  assert.equal(cli(['scan', dir, '--go', 'none', '--history', '-o', out]).code, 0);
  const a = readJson(out).analyses.find((x) => x.tool === 'git log');
  assert.equal(a.status, 'skipped');
  const bad = cli(['scan', dir, '--go', 'none', '--history', '--since', 'last tuesday']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--since must be <N>d/);
});
