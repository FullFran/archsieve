import { posix } from 'node:path';
import { run } from './util.mjs';
import { SCHEMA_VERSION } from './scan.mjs';
import { testMatcher } from './tests.mjs';

// Which code depends on a set of changed files: the reverse transitive closure over the snapshot's
// import edges, the test files inside it, and `blind`, every reason the answer may be incomplete.
// No prediction and no score: a consumer that needs certainty falls back to everything when
// `blind` is not empty.

const LIMITATIONS = [
  'Static imports only: computed dynamic imports (import(`./x/${name}`)), runtime loading, reflection and non-code dependencies (data files, configs, environment) are invisible, so they never appear in files or blind.',
  'The graph is the snapshot\'s: scan the same tree the changes are in. A snapshot taken from a dirty working tree cannot be checked against later uncommitted edits.',
];

const stem = (p) => posix.basename(p).replace(/\.[^.]+$/, '');

function gitChanged(repo, base) {
  const fail = (msg, code = 'BAD_INPUT') => Object.assign(new Error(msg), { code });
  const ok = run('git', ['rev-parse', '--verify', `${base}^{commit}`], { cwd: repo });
  if (ok.status !== 0) throw fail(`unknown git ref: ${base}`);
  const prefix = run('git', ['rev-parse', '--show-prefix'], { cwd: repo }).stdout.trim();
  const res = run('git', ['diff', '--name-only', '--no-renames', base], { cwd: repo });
  if (res.status !== 0) throw fail(`git diff failed: ${res.stderr.trim()}`, 'TOOL_FAILED');
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no', '--', '.'], { cwd: repo }).stdout.trim().length > 0;
  const inside = [], outside = [];
  for (const f of res.stdout.split('\n').filter(Boolean)) (f.startsWith(prefix) ? inside : outside).push(f.slice(f.startsWith(prefix) ? prefix.length : 0));
  return { inside, outside, head, dirty };
}

export function affected(snapshot, { changed = [], base = null, repo = '.', ignore = [] } = {}) {
  const blind = [];
  let files = changed, outside = [];
  if (base) {
    const g = gitChanged(repo, base);
    files = [...changed, ...g.inside];
    outside = g.outside;
    const { commit, dirty } = snapshot.subject;
    if (commit !== g.head || (dirty === false && g.dirty)) {
      blind.push({ reason: 'stale-snapshot', detail: `snapshot of ${commit ?? 'no commit'}${dirty ? ' (dirty)' : ''}, repository at ${g.head}${g.dirty ? ' with uncommitted changes' : ''}` });
    }
  }
  const norm = (f) => posix.normalize(f.replaceAll('\\', '/')).replace(/^\.\//, '');
  const isIgnored = testMatcher(ignore);
  const all = [...new Set(files.map(norm))].sort();
  const ignored = ignore.length ? all.filter(isIgnored) : [];
  const kept = all.filter((f) => !ignored.includes(f));

  // Seeds: file nodes by path; a Go source file by its package directory.
  const nodes = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const goByDir = new Map(snapshot.nodes.filter((n) => n.kind === 'go-package').map((n) => [n.file, n.id]));
  const seeds = [];
  for (const f of kept) {
    if (nodes.get(f)?.kind === 'file' || nodes.get(f)?.kind === 'vendored-file') seeds.push(f);
    else if (f.endsWith('.go') && goByDir.has(posix.dirname(f))) seeds.push(goByDir.get(posix.dirname(f)));
    else blind.push({ reason: 'not-in-graph', file: f });
  }
  for (const f of outside) blind.push({ reason: 'outside-snapshot', file: f });

  const importers = new Map();
  for (const e of snapshot.edges) {
    if (e.kind !== 'imports') continue;
    if (!importers.has(e.target)) importers.set(e.target, []);
    importers.get(e.target).push(e.source);
  }
  const reached = new Set(seeds);
  for (const queue = [...seeds]; queue.length;) {
    for (const s of importers.get(queue.pop()) ?? []) if (!reached.has(s)) { reached.add(s); queue.push(s); }
  }
  const closure = [...reached].sort();

  // An unresolved import may point into the closure when its last segment names a reached file
  // (or the folder of a reached index file). Matching by name is a heuristic, so it only adds blindness.
  const names = new Set([...closure, ...kept].flatMap((f) => (stem(f) === 'index' ? [posix.basename(posix.dirname(f))] : [stem(f)])));
  for (const f of snapshot.findings) {
    if (f.rule !== 'unresolved-import') continue;
    const spec = f.evidence?.[0]?.detail;
    if (spec && names.has(stem(spec.replace(/\/+$/, '')))) blind.push({ reason: 'unresolved-import', file: f.subjects[0], detail: spec });
  }
  for (const a of snapshot.analyses) if (a.status !== 'ok') blind.push({ reason: 'analysis-skipped', detail: `${a.tool} (${a.scope}): ${a.note ?? a.status}` });
  const marked = snapshot.analyses.some((a) => a.tool === 'test globs');
  if (!marked) blind.push({ reason: 'no-test-marks', detail: 'the snapshot predates the test/production split; rescan with archsieve >= 0.3' });

  const key = (b) => `${b.reason}\u0000${b.file ?? ''}\u0000${b.detail ?? ''}`;
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'archsieve-affected',
    subject: snapshot.subject,
    ...(base ? { base } : {}),
    changed: all,
    ignored,
    files: closure,
    tests: closure.filter((id) => nodes.get(id)?.test),
    blind: [...new Map(blind.map((b) => [key(b), b])).values()].sort((a, b) => (key(a) < key(b) ? -1 : 1)),
    limitations: LIMITATIONS,
  };
}
