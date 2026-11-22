import { run, byKey } from '../util.mjs';

// Change history as a separate evidence source: `git log --name-only`, read only. It yields churn
// (commits per file and per container) and co-change between containers. Co-change is a heuristic
// (Code Maat's change coupling): it is reported as a signal, never as an error, and never as a link.
//
// Determinism: the window is anchored at the scanned commit's committer date, not at "now", so the
// same commit gives the same snapshot. Commits touching more than MAX_CHANGESET files (sweeping
// renames, formatting, vendoring) say nothing about coupling and are left out, as Code Maat does.
export const MAX_CHANGESET = 50;
export const DEFAULT_SINCE = '90d';
export const DEFAULT_CO_CHANGE_MIN = 5;

// Files that are neither code nor configuration: docs, images and lockfiles change with the code they
// describe or pin, which is good practice, not coupling (#39). They keep their own file churn but do not
// make a commit count for a container, so they never pair containers.
const NOT_COUPLING = /\.(md|mdx|markdown|rst|adoc|txt|png|jpe?g|gif|webp|ico|pdf)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|go\.sum|Cargo\.lock|poetry\.lock|uv\.lock)$/i;
export const isCouplingEvidence = (file) => !NOT_COUPLING.test(file);
const MIN_DEGREE = 0.5;

const usage = (m) => Object.assign(new Error(m), { code: 'USAGE' });

export function readHistory(cwd, { commit = 'HEAD', since = DEFAULT_SINCE } = {}) {
  const days = /^(\d+)d$/.exec(since);
  if (!days && !(/^\d{4}-\d{2}-\d{2}/.test(since) && Number.isFinite(Date.parse(since)))) throw usage(`--since must be <N>d (days before the scanned commit) or an ISO date, got: ${since}`);
  const head = run('git', ['log', '-1', '--format=%ct', commit], { cwd });
  if (head.status !== 0) return { skipped: `not a git checkout or no commit (${head.stderr.trim().split('\n').pop()})` };
  const headTs = Number(head.stdout.trim());
  const cutoff = days ? headTs - Number(days[1]) * 86400 : Date.parse(since) / 1000;
  const iso = new Date(cutoff * 1000).toISOString().replace('.000Z', 'Z');
  const res = run('git', ['log', '--no-merges', '--no-renames', '--relative', '--name-only', '--format=%x00%ct', `--since=${iso}`, commit, '--', '.'], { cwd });
  if (res.status !== 0) return { skipped: `git log failed: ${res.stderr.trim().split('\n').pop()}` };
  const commits = [];
  let large = 0;
  for (const block of res.stdout.split('\0').slice(1)) {
    const [ts, ...lines] = block.split('\n');
    if (Number(ts) < cutoff) continue;
    const files = [...new Set(lines.filter(Boolean))];
    if (files.length > MAX_CHANGESET) { large++; continue; }
    if (files.length) commits.push(files);
  }
  return { commits, large, since: iso };
}

// Adds `churn` to file, Go package and container nodes, and returns co-change findings.
export function applyHistory(snapshot, history, { coChangeMin = DEFAULT_CO_CHANGE_MIN } = {}) {
  // Deepest container first; the root (`.`) always last, or it would tie with one-letter paths and win.
  const depth = (u) => (u.path === '.' ? 0 : u.path.length);
  const units = snapshot.nodes.filter((n) => n.kind === 'container').sort(byKey((u) => String(1e6 - depth(u)).padStart(7, '0') + u.path));
  const within = (file, dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`);
  const unitOf = (file) => units.find((u) => within(file, u.path));
  const fileChurn = new Map(), unitChurn = new Map(), pairs = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const files of history.commits) {
    for (const f of files) bump(fileChurn, f);
    const touched = [...new Set(files.filter(isCouplingEvidence).map(unitOf).filter(Boolean).map((u) => u.id))].sort();
    for (const u of touched) bump(unitChurn, u);
    for (let i = 0; i < touched.length; i++) for (let j = i + 1; j < touched.length; j++) bump(pairs, `${touched[i]}\u0000${touched[j]}`);
  }
  const dirChurn = new Map();
  for (const [f, n] of fileChurn) { const d = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.'; dirChurn.set(d, (dirChurn.get(d) ?? 0) + n); }
  for (const n of snapshot.nodes) {
    const c = n.kind === 'file' ? fileChurn.get(n.id) : n.kind === 'go-package' ? dirChurn.get(n.file) : n.kind === 'container' ? unitChurn.get(n.id) : undefined;
    if (c) n.churn = c;
  }
  // A static link in either direction explains co-change; only unexplained pairs are signals.
  const linked = new Set(snapshot.edges.filter((e) => e.kind === 'depends-on' && Object.keys(e.relations ?? {}).length).flatMap((e) => [`${e.source}\u0000${e.target}`, `${e.target}\u0000${e.source}`]));
  const findings = [];
  for (const [k, shared] of [...pairs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [a, b] = k.split('\u0000');
    const degree = shared / Math.min(unitChurn.get(a), unitChurn.get(b));
    if (shared < coChangeMin || degree < MIN_DEGREE || linked.has(k)) continue;
    findings.push({
      level: 'signal', rule: 'co-change-without-link', subjects: [a, b],
      message: `${a} and ${b} changed together in ${shared} commits since ${history.since} (${Math.round(degree * 100)}% of the less active one's ${Math.min(unitChurn.get(a), unitChurn.get(b))}), with no import or package dependency between them: a hidden runtime, data or contract coupling?`,
      evidence: [{ tool: 'git log', detail: `${shared} shared commits since ${history.since}` }],
    });
  }
  return findings;
}
