import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { byKey } from './util.mjs';
import { globToRegExp } from './tests.mjs';

// Production files that only tests keep alive (#9): a non-test file whose importers are all test
// files or other such files, and which is no entry point (package.json main/module/browser/bin/
// exports of its container, or --entry-globs). Grouped by the highest folder whose production files
// all qualify, so a retired subsystem is one signal with its size. Never an error: a file may be
// loaded by path at runtime, which static analysis cannot see.
const MAX_EVIDENCE = 5;

function manifestEntries(root, snapshot) {
  const entries = new Set();
  const add = (dir, p) => { if (typeof p === 'string') entries.add(posix.normalize(posix.join(dir, p))); };
  const walk = (dir, v) => {
    if (typeof v === 'string') add(dir, v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(dir, x);
  };
  for (const u of snapshot.nodes.filter((n) => n.kind === 'container')) {
    const manifest = u.evidence.find((e) => e.tool === 'manifest' && e.file?.endsWith('package.json'))?.file;
    if (!manifest) continue;
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(root, manifest), 'utf8')); } catch { continue; }
    const dir = posix.dirname(manifest);
    for (const field of ['main', 'module', 'browser', 'bin', 'exports']) walk(dir, pkg[field]);
  }
  return entries;
}

export function testOnlyModules(root, snapshot, { entryGlobs = [] } = {}) {
  const nodes = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const isTest = (id) => nodes.get(id)?.test === true;
  const production = snapshot.nodes.filter((n) => n.kind === 'file' && !n.test).map((n) => n.id);
  const entry = manifestEntries(root, snapshot);
  const globs = entryGlobs.map(globToRegExp);
  const isEntry = (f) => entry.has(f) || globs.some((re) => re.test(f));
  const importers = new Map();
  for (const e of snapshot.edges) {
    if (e.kind !== 'imports' || e.source === e.target) continue;
    if (!importers.has(e.target)) importers.set(e.target, new Set());
    importers.get(e.target).add(e.source);
  }
  // Greatest fixed point: start from every imported, non-entry production file and drop any file
  // that a production file outside the set imports.
  const candidates = new Set(production.filter((f) => importers.has(f) && !isEntry(f)));
  for (let changed = true; changed;) {
    changed = false;
    for (const f of [...candidates]) {
      if ([...importers.get(f)].some((s) => !isTest(s) && !candidates.has(s))) { candidates.delete(f); changed = true; }
    }
  }
  // Keep only files a test reaches: a cycle nobody imports is an orphan, not test-only.
  const reached = new Set([...candidates].filter((f) => [...importers.get(f)].some(isTest)));
  for (let grew = true; grew;) {
    grew = false;
    for (const f of candidates) if (!reached.has(f) && [...importers.get(f)].some((s) => reached.has(s))) { reached.add(f); grew = true; }
  }
  const flagged = [...reached].sort();
  const all = new Set(flagged);
  const under = (dir) => production.filter((f) => f.startsWith(`${dir}/`));
  // Groups never cross a container: climbing stops at the deepest container holding the file.
  const units = snapshot.nodes.filter((n) => n.kind === 'container').map((n) => n.path).sort((a, b) => b.length - a.length);
  const unitOf = (f) => units.find((p) => p === '.' || f.startsWith(`${p}/`));
  const groupOf = (f) => {
    let best = null;
    const top = unitOf(f);
    for (let d = posix.dirname(f); d !== '.' && d !== '/' && (!top || top === '.' || d === top || d.startsWith(`${top}/`)); d = posix.dirname(d)) {
      if (under(d).every((x) => all.has(x))) best = d; else break;
    }
    return best ?? f;
  };
  const groups = new Map();
  for (const f of flagged) {
    const g = groupOf(f);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  const lines = (f) => {
    try {
      const t = readFileSync(join(root, f), 'utf8');
      return t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0;
    } catch { return 0; }
  };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const findings = [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([g, files]) => {
    const set = new Set(files);
    const ev = snapshot.edges.filter((e) => e.kind === 'imports' && set.has(e.target) && isTest(e.source))
      .map((e) => ({ tool: 'archsieve', file: e.source, detail: `imports ${e.target}` })).sort(byKey((x) => `${x.file}\u0000${x.detail}`));
    const tests = new Set(ev.map((x) => x.file)).size;
    const size = files.reduce((s, f) => s + lines(f), 0);
    const label = groups.get(g).length === 1 && g === files[0] ? g : `${g}/`;
    return {
      level: 'signal', rule: 'test-only-module', subjects: files,
      message: `${label}: ${plural(files.length, 'production file')} (${plural(size, 'line')}) ${files.length === 1 ? 'is' : 'are'} imported only by tests (${plural(tests, 'test file')})${files.length > 1 ? ' and by each other' : ''}, and no manifest or --entry-globs names ${files.length === 1 ? 'it' : 'them'} as an entry point. Retired code kept alive by its tests? It may still be loaded by path at runtime, which static analysis cannot see.`,
      evidence: ev.length > MAX_EVIDENCE ? [...ev.slice(0, MAX_EVIDENCE), { tool: 'archsieve', detail: `${ev.length - MAX_EVIDENCE} more` }] : ev,
    };
  });
  return { findings, entryPoints: entry.size, files: flagged.length };
}
