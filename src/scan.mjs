import { basename, resolve } from 'node:path';
import { existsSync, statSync, mkdtempSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, byKey, edgeKey } from './util.mjs';
import { scanDepcruise, DEFAULT_EXCLUDE, VENDOR, VERSION as DC_VERSION } from './adapters/depcruise.mjs';
import { scanGo, goVersion } from './adapters/golist.mjs';
import { scanNest } from './adapters/nest.mjs';
import { scanUnits, linkUnits, MANIFESTS } from './adapters/units.mjs';
import { readLikeC4 } from './adapters/likec4.mjs';
import { applyModel, crossCheckLinks, modelEvidenceFile } from './model.mjs';
import { markTests, testMatcher, DEFAULT_TEST_GLOBS } from './tests.mjs';
import { runtimeLinks } from './adapters/patterns.mjs';
import { containerFacts } from './adapters/facts.mjs';
import { tsConfigHints } from './adapters/tsconfig.mjs';
import { readHistory, applyHistory, DEFAULT_SINCE, MAX_CHANGESET } from './adapters/history.mjs';

export const SCHEMA_VERSION = '0.5';

const LIMITATIONS = {
  'dependency-cruiser': 'Static import graph only: no runtime calls, network/IPC/queue/event links, reflection or computed dynamic imports. Unresolvable imports are listed as unknown findings, not guessed.',
  'go list': 'Go package import graph only; standard library omitted; external packages collapsed to host/org/repo. Built with the current GOOS/GOARCH and no build tags, so tagged files may be missing. Rust/Tauri code is not analyzed in V0.',
  manifests: 'Units come from manifests read as data (package.json, Cargo targets via cargo metadata, go.mod and Go main packages, tauri.conf.json). Links between units at runtime (HTTP, IPC, child processes) are not visible statically.',
  model: 'The declared model is read as exported, never run. A declared-unverified link is not wrong, only unproven: runtime links (HTTP, IPC, child processes) have no static evidence.',
  patterns: 'Runtime links from call sites are read line by line, not parsed (ADR 0006): a child-process call (JS/TS spawn, execFile, fork, execa; Rust Command::new; Tauri sidecars) counts only when its program is a string literal or a same-file constant, and it is matched to a container by path or bin name. HTTP calls count only when their literal path matches the routes of exactly one other container. Calls built at runtime are unknown findings (programs) or only counted (URLs); IPC and queues are not covered.',
  history: 'Change history (git log) is a heuristic: churn counts commits, and co-change between containers is a signal of hidden coupling, never proof of a link. Commits touching more than ' + MAX_CHANGESET + ' files are left out.',
  'nest': 'NestJS DI graph as registered by Nest in preview mode: providers are not instantiated, so factory/value providers and anything resolved via ModuleRef/request scope at runtime is not visible.',
};

function gitInfo(root) {
  try {
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: root });
    if (head.status !== 0) return { commit: null, dirty: null };
    const st = run('git', ['status', '--porcelain', '--untracked-files=no', '--', '.'], { cwd: root });
    return { commit: head.stdout.trim(), dirty: st.stdout.trim().length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

// Manifest files: tracked plus untracked-but-not-ignored, so a dirty working tree is seen as it is.
function manifestFiles(root, exclude, paths) {
  const re = new RegExp(exclude), vendor = new RegExp(VENDOR);
  const keep = (f) => !re.test(f) && !vendor.test(f) && (!paths || paths.some((p) => f === p || f.startsWith(`${p.replace(/\/$/, '')}/`)));
  const res = gitLsFiles(root, MANIFESTS);
  const files = res
    ? res.stdout.split('\n').filter(Boolean)
    : MANIFESTS.flatMap((m) => findFiles(root, m, (r) => !re.test(`${r}/`) && !vendor.test(`${r}/`)));
  return [...new Set(files)].filter(keep).sort();
}

// Tracked plus untracked-but-not-ignored files with these names; null outside a git checkout or without git.
function gitLsFiles(root, names) {
  try {
    const res = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...names.flatMap((m) => [m, `*/${m}`])], { cwd: root });
    return res.status === 0 ? res : null;
  } catch {
    return null;
  }
}

function goModules(root, exclude) {
  const re = new RegExp(exclude), vendor = new RegExp(VENDOR);
  const res = gitLsFiles(root, ['go.mod']);
  // Outside a git checkout (e.g. a --ref export) walk the tree instead.
  const files = res ? res.stdout.split('\n').filter(Boolean) : findFiles(root, 'go.mod', (r) => !re.test(`${r}/`) && !vendor.test(`${r}/`));
  return files.map((f) => f.replace(/\/?go\.mod$/, '') || '.').filter((d) => d === '.' || (!re.test(`${d}/`) && !vendor.test(`${d}/`))).sort();
}

// tsconfig*.json files, tracked or untracked-but-not-ignored, outside excluded and vendored dirs.
function tsConfigFiles(root, exclude) {
  const re = new RegExp(exclude), vendor = new RegExp(VENDOR);
  const isTs = (n) => /^tsconfig.*\.json$/.test(n);
  const res = gitLsFiles(root, ['tsconfig*.json']);
  const files = res ? res.stdout.split('\n').filter(Boolean) : findFiles(root, isTs, (r) => !re.test(`${r}/`) && !vendor.test(`${r}/`));
  return [...new Set(files)].filter((f) => isTs(f.split('/').pop()) && !re.test(f) && !vendor.test(f)).sort();
}

// Production Rust or Go sources for the runtime patterns: tracked plus untracked-but-not-ignored, so
// target/ stays out; outside git, a bounded walk that skips target/.
function sourceFiles(root, exclude, paths, isTest, ext) {
  const re = new RegExp(exclude), vendor = new RegExp(VENDOR);
  const keep = (f) => !re.test(f) && !vendor.test(f) && !/(^|\/)target\//.test(f) && !isTest(f) && (!paths || paths.some((p) => f.startsWith(`${p.replace(/\/$/, '')}/`)));
  const res = gitLsFiles(root, [`*${ext}`]);
  const files = res ? res.stdout.split('\n').filter(Boolean) : findFiles(root, (n) => n.endsWith(ext), (r) => !re.test(`${r}/`) && !vendor.test(`${r}/`) && !r.endsWith('target'), '', 8);
  return [...new Set(files)].filter((f) => f.endsWith(ext) && keep(f)).sort();
}

// Every file for container facts: tracked plus untracked-but-not-ignored; outside git, a walk.
function allFiles(root, exclude, paths) {
  const re = new RegExp(exclude), vendor = new RegExp(VENDOR);
  const keep = (f) => !re.test(f) && !vendor.test(f) && (!paths || paths.some((p) => f.startsWith(`${p.replace(/\/$/, '')}/`)));
  let res = null;
  try { res = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { cwd: root }); } catch { /* no git */ }
  const files = res?.status === 0 ? res.stdout.split('\0').filter(Boolean) : findFiles(root, () => true, (r) => !re.test(`${r}/`) && !vendor.test(`${r}/`), '', 30);
  return [...new Set(files)].filter(keep).sort();
}

function findFiles(root, name, keep, rel = '', depth = 4) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isFile() && (typeof name === 'function' ? name(e.name) : e.name === name)) out.push(r);
    else if (e.isDirectory() && depth > 0 && e.name !== '.git' && keep(r)) out.push(...findFiles(root, name, keep, r, depth - 1));
  }
  return out;
}

// dependency-cruiser walks the file system and ignores .gitignore. Excluding git-ignored
// directories keeps local caches/build output out of the graph (same commit -> same graph).
function gitIgnoredDirs(root) {
  try {
    const res = run('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'], { cwd: root });
    if (res.status !== 0) return [];
    return res.stdout.split('\n').filter((l) => l.endsWith('/')).map((d) => d.slice(0, -1));
  } catch {
    return [];
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function findingId(f) {
  return `${f.rule}:${f.subjects.join('|')}`;
}

// Scan a committed state without touching the working tree: `git archive` (no hooks, no checkout)
// into a temp dir. Installed node_modules of the working tree are linked read-only so package
// imports still resolve; that resolution reflects the CURRENT install, not the one at <ref>.
export function scanRef(target, ref, opts = {}) {
  const repo = resolve(target);
  const sha = run('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repo });
  if (sha.status !== 0) { const e = new Error(`unknown git ref: ${ref}`); e.code = 'BAD_INPUT'; throw e; }
  const commit = sha.stdout.trim();
  const tmp = mkdtempSync(join(tmpdir(), 'archsieve-ref-'));
  const name = basename(repo);
  const tree = join(tmp, name);
  try {
    const tar = run('git', ['archive', '--format=tar', commit], { cwd: repo, encoding: 'buffer' });
    if (tar.status !== 0) { const e = new Error(`git archive failed for ${ref}`); e.code = 'TOOL_FAILED'; throw e; }
    run('mkdir', ['-p', tree]);
    const x = run('tar', ['-x', '-C', tree], { input: tar.stdout });
    if (x.status !== 0) { const e = new Error(`tar failed: ${x.stderr}`); e.code = 'TOOL_FAILED'; throw e; }
    for (const rel of nodeModulesDirs(repo)) {
      const dst = join(tree, rel);
      if (existsSync(join(dst, '..')) && !existsSync(dst)) symlinkSync(join(repo, rel), dst);
    }
    return scan(tree, { ...opts, subject: { name, commit, dirty: false }, historyFrom: { cwd: repo, commit } });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function nodeModulesDirs(repo, depth = 2, rel = '') {
  const out = [];
  let entries = [];
  try { entries = readdirSync(join(repo, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.git') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name === 'node_modules') out.push(r);
    else if (depth > 0 && !new RegExp(DEFAULT_EXCLUDE).test(`${r}/`)) out.push(...nodeModulesDirs(repo, depth - 1, r));
  }
  return out;
}

export function scan(target, opts = {}) {
  const root = resolve(target);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    const err = new Error(`not a directory: ${target}`);
    err.code = 'BAD_INPUT';
    throw err;
  }
  const ignored = (opts.subject ? [] : gitIgnoredDirs(root)).filter((d) => !new RegExp(VENDOR).test(`${d}/`));
  const exclude = [DEFAULT_EXCLUDE, ...(opts.exclude ? [opts.exclude] : []), ...(ignored.length ? [`^(${ignored.map(escapeRe).join('|')})(/|$)`] : [])].join('|');
  const parts = [], tools = [], analyses = [], limitations = [];

  if (opts.js !== false) {
    const auto = opts.tsConfig === 'auto';
    const given = auto ? null : opts.tsConfig ?? null;
    let js = scanDepcruise(root, { paths: opts.paths, exclude, tsConfig: given });
    // Unresolved imports that a tsconfig `paths` alias would resolve: hint the exact flag, or with
    // --ts-config auto rescan with the only tsconfig that matches.
    const unresolved = () => js.findings.filter((f) => f.rule === 'unresolved-import');
    const tsFiles = unresolved().length ? tsConfigFiles(root, exclude) : [];
    let hints = tsConfigHints(root, tsFiles, unresolved()).filter((h) => h.file !== given?.replace(/^\.\//, ''));
    let note;
    if (auto) {
      if (hints.length === 1) {
        note = `--ts-config auto: ${hints[0].file} (paths matched ${hints[0].count} unresolved imports)`;
        js = scanDepcruise(root, { paths: opts.paths, exclude, tsConfig: hints[0].file });
        hints = tsConfigHints(root, tsFiles, unresolved()).filter((h) => h.file !== hints[0].file);
      } else note = `--ts-config auto: ${hints.length ? `ambiguous (${hints.map((h) => h.file).join(', ')}), none used` : 'no tsconfig paths match the unresolved imports, none used'}`;
    } else if (given) note = `--ts-config ${given}`;
    js.findings.push(...hints.map((h) => h.finding));
    parts.push(js);
    tools.push({ name: 'dependency-cruiser', version: DC_VERSION });
    analyses.push({ tool: 'dependency-cruiser', scope: (opts.paths ?? ['.']).join(','), status: 'ok', ...(note ? { note } : {}) });
    limitations.push(LIMITATIONS['dependency-cruiser']);
  }

  const goMains = [];
  const goDirs = opts.go === 'none' ? [] : opts.go && opts.go !== 'auto' ? opts.go.split(',') : goModules(root, exclude);
  if (goDirs.length) {
    let version = null;
    try { version = goVersion(); } catch (e) {
      analyses.push({ tool: 'go list', scope: goDirs.join(','), status: 'skipped', note: `${e.message}; Go packages not analyzed` });
    }
    if (version) {
      tools.push({ name: 'go', version });
      for (const d of goDirs) {
        const p = scanGo(root, d);
        parts.push(p);
        goMains.push(...p.mains);
        analyses.push({ tool: 'go list', scope: d, status: 'ok', note: `module ${p.module}` });
      }
      limitations.push(LIMITATIONS['go list']);
    }
  }

  const model = opts.model ? readLikeC4(opts.model) : null;
  let declared = null;
  if (opts.units !== false || model) {
    const units = opts.units !== false;
    const files = units ? manifestFiles(root, exclude, opts.paths) : [];
    const u = units ? scanUnits(root, { files, goMains }) : { nodes: [], edges: [], findings: [] };
    parts.push(u);
    if (units) {
      tools.push(...u.tools);
      analyses.push({ tool: 'manifests', scope: (opts.paths ?? ['.']).join(','), status: 'ok', note: `${u.nodes.length} units from ${files.length} manifests` }, ...u.analyses);
      limitations.push(LIMITATIONS.manifests);
    }
    if (model) {
      const evFile = modelEvidenceFile(root, opts.model);
      declared = applyModel(root, u.nodes, model, evFile);
      parts.push({ nodes: declared.nodes, edges: [], findings: declared.findings });
      analyses.push({ tool: 'declared model', scope: evFile, status: 'ok', note: `${model.format}: ${model.elements.length} elements, ${model.links.length} links` });
      limitations.push(LIMITATIONS.model);
    }
  }

  if (opts.nestEntry) {
    const p = scanNest(root, opts.nestEntry, opts.nestExport ?? 'AppModule');
    parts.push(p);
    tools.push({ name: '@nestjs/core', version: p.version });
    analyses.push({ tool: '@nestjs/core SerializedGraph', scope: opts.nestEntry, status: 'ok', note: 'preview mode; module top-level code executed' });
    limitations.push(LIMITATIONS.nest);
  }

  if (!parts.length) {
    const err = new Error('no analyzer ran (nothing to scan)');
    err.code = 'NOTHING_SCANNED';
    throw err;
  }
  const snapshot = assemble(opts.subject ?? { name: basename(root), ...gitInfo(root) }, tools, analyses, parts, limitations);
  const testGlobs = opts.testGlobs ?? DEFAULT_TEST_GLOBS;
  const marked = markTests(snapshot.nodes, testGlobs);
  snapshot.analyses.push({ tool: 'test globs', scope: (opts.paths ?? ['.']).join(','), status: 'ok', note: `${marked} test files or packages; globs: ${testGlobs.join(', ')}` });
  if (opts.units !== false || declared) {
    snapshot.edges.push(...linkUnits(root, snapshot));
  }
  if (opts.units !== false) {
    const containers = snapshot.nodes.filter((n) => n.kind === 'container');
    const files = allFiles(root, exclude, opts.paths);
    const cf = containerFacts(root, containers, files);
    for (const n of containers) n.facts = cf.facts.get(n.id);
    snapshot.analyses.push({ tool: 'container facts', scope: (opts.paths ?? ['.']).join(','), status: 'ok', note: `${files.length} files; ${cf.outside} file${cf.outside === 1 ? '' : 's'} outside every container${cf.unreadable ? `; ${cf.unreadable} unreadable` : ''}` });
    const isTest = testMatcher(testGlobs);
    const r = runtimeLinks(root, snapshot, { rustFiles: sourceFiles(root, exclude, opts.paths, isTest, '.rs'), goFiles: sourceFiles(root, exclude, opts.paths, isTest, '.go') });
    snapshot.edges.push(...r.edges);
    for (const f of r.findings) snapshot.findings.push({ id: findingId(f), ...f });
    snapshot.analyses.push(r.analysis);
    snapshot.limitations.push(LIMITATIONS.patterns);
  }
  if (declared) {
    for (const f of crossCheckLinks(snapshot, declared.links)) snapshot.findings.push({ id: findingId(f), ...f });
  }
  if (opts.history) {
    const since = opts.since ?? DEFAULT_SINCE;
    const from = opts.historyFrom ?? { cwd: root, commit: 'HEAD' };
    const h = readHistory(from.cwd, { commit: from.commit, since });
    if (h.skipped) snapshot.analyses.push({ tool: 'git log', scope: since, status: 'skipped', note: h.skipped });
    else {
      for (const f of applyHistory(snapshot, h, { coChangeMin: opts.coChangeMin })) snapshot.findings.push({ id: findingId(f), ...f });
      snapshot.analyses.push({ tool: 'git log', scope: since, status: 'ok', note: `${h.commits.length} commits since ${h.since}${h.large ? `; ${h.large} commits touching more than ${MAX_CHANGESET} files left out` : ''}` });
      snapshot.limitations.push(LIMITATIONS.history);
    }
  }
  snapshot.findings.sort(byKey((f) => f.id));
  snapshot.edges.sort(byKey(edgeKey));
  return snapshot;
}

export function assemble(subject, tools, analyses, parts, limitations) {
  const nodes = new Map(), edges = new Map(), findings = new Map();
  for (const p of parts) {
    for (const n of p.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
    for (const e of p.edges) {
      const k = edgeKey(e);
      if (edges.has(k)) {
        const prev = edges.get(k);
        const ev = new Map([...prev.evidence, ...e.evidence].map((x) => [JSON.stringify(x), x]));
        prev.evidence = [...ev.values()].sort(byKey((x) => JSON.stringify(x)));
        if (prev.typeOnly && !e.typeOnly) delete prev.typeOnly;
      } else edges.set(k, { ...e, evidence: [...e.evidence] });
    }
    for (const f of p.findings) {
      const id = findingId(f);
      if (!findings.has(id)) findings.set(id, { id, ...f });
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'archsieve-snapshot',
    subject,
    tools: tools.sort(byKey((t) => t.name)),
    analyses,
    nodes: [...nodes.values()].sort(byKey((n) => n.id)),
    edges: [...edges.values()].sort(byKey(edgeKey)),
    findings: [...findings.values()].sort(byKey((f) => f.id)),
    limitations,
  };
}
