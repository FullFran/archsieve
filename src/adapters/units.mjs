import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { run, byKey } from '../util.mjs';
import { pyprojectInfo, pythonRunnable } from './pyproject.mjs';

// Observed units (C4 containers and packages) from manifests. Manifests are read as data and
// never executed: JSON files are parsed, Cargo targets come from `cargo metadata --no-deps`
// (which does not run build scripts), Go main packages come from the go list adapter.
export const MANIFESTS = ['package.json', 'Cargo.toml', 'tauri.conf.json', 'go.mod', 'pyproject.toml'];

const dirOf = (file) => posix.dirname(file);

export function cargoVersion() {
  return run('cargo', ['--version']).stdout.trim();
}

export function scanUnits(root, { files, goMains = [] }) {
  const units = new Map(), findings = [], analyses = [], tools = [];
  const unit = (path) => {
    if (!units.has(path)) units.set(path, { id: `container:${path}`, kind: 'container', path, title: null, technology: new Set(), runnable: false, evidence: [] });
    return units.get(path);
  };
  const readJson = (file) => {
    try {
      return JSON.parse(readFileSync(join(root, file), 'utf8'));
    } catch (e) {
      findings.push({ level: 'unknown', rule: 'manifest-unreadable', subjects: [file], message: `Manifest could not be parsed as JSON: ${e.message.slice(0, 160)}`, evidence: [{ tool: 'manifest', file }] });
      return null;
    }
  };
  const of = (name) => files.filter((f) => posix.basename(f) === name).sort();

  for (const file of of('package.json')) {
    const pkg = readJson(file);
    if (!pkg) continue;
    const u = unit(dirOf(file));
    u.title ??= pkg.name ?? null;
    u.technology.add('node');
    const reason = pkg.bin ? 'bin' : pkg.scripts?.start ? 'scripts.start' : null;
    if (reason) u.runnable = true;
    u.evidence.push({ tool: 'manifest', file, ...(reason ? { detail: reason } : {}) });
  }

  const cargoFiles = of('Cargo.toml');
  if (cargoFiles.length) {
    let version = null;
    try { version = cargoVersion(); } catch (e) {
      analyses.push({ tool: 'cargo metadata', scope: cargoFiles.map(dirOf).join(','), status: 'skipped', note: `${e.message}; Rust units not analyzed` });
    }
    if (version) {
      tools.push({ name: 'cargo', version });
      for (const file of cargoFiles) {
        const res = run('cargo', ['metadata', '--no-deps', '--offline', '--format-version', '1', '--manifest-path', join(root, file)], { cwd: root });
        if (res.status !== 0) {
          findings.push({ level: 'unknown', rule: 'manifest-unreadable', subjects: [file], message: `cargo metadata failed: ${res.stderr.trim().split('\n').pop()?.slice(0, 160)}`, evidence: [{ tool: 'cargo metadata', file }] });
          continue;
        }
        const own = JSON.parse(res.stdout).packages.filter((p) => posix.normalize(p.manifest_path.replaceAll('\\', '/')).endsWith(`/${file}`));
        for (const p of own) {
          const u = unit(dirOf(file));
          u.title ??= p.name;
          u.technology.add('rust');
          const bins = p.targets.filter((t) => t.kind.includes('bin')).map((t) => t.name).sort();
          if (bins.length) u.runnable = true;
          u.evidence.push({ tool: 'cargo metadata', file, ...(bins.length ? { detail: `bin ${bins.join(',')}` } : {}) });
        }
      }
      analyses.push({ tool: 'cargo metadata', scope: cargoFiles.map(dirOf).join(','), status: 'ok' });
    }
  }

  for (const file of of('go.mod')) {
    const u = unit(dirOf(file));
    let text = '';
    try { text = readFileSync(join(root, file), 'utf8'); } catch { /* listed but unreadable: keep the unit, no title */ }
    u.title ??= /^module\s+(\S+)/m.exec(text)?.[1] ?? null;
    u.technology.add('go');
    u.evidence.push({ tool: 'manifest', file });
  }
  for (const { dir, importPath } of goMains) {
    const u = unit(dir);
    u.title ??= importPath;
    u.technology.add('go');
    u.runnable = true;
    u.evidence.push({ tool: 'go list', file: dir, detail: 'package main' });
  }

  for (const file of of('pyproject.toml')) {
    let info;
    try { info = pyprojectInfo(readFileSync(join(root, file), 'utf8')); } catch (e) {
      findings.push({ level: 'unknown', rule: 'manifest-unreadable', subjects: [file], message: `Manifest could not be parsed as TOML: ${e.message.slice(0, 160)}`, evidence: [{ tool: 'manifest', file }] });
      continue;
    }
    if (!info) continue; // tool configuration or a virtual workspace root: no project, no unit
    const u = unit(dirOf(file));
    u.title ??= info.name;
    u.technology.add('python');
    const reason = pythonRunnable(root, dirOf(file) === '.' ? '' : dirOf(file), info);
    if (reason) u.runnable = true;
    u.evidence.push({ tool: 'manifest', file, ...(reason ? { detail: reason } : {}) });
  }

  for (const file of of('tauri.conf.json')) {
    const conf = readJson(file);
    if (!conf) continue;
    const u = unit(dirOf(file));
    u.title ??= conf.productName ?? null;
    u.technology.add('tauri');
    u.evidence.push({ tool: 'manifest', file });
  }

  const nodes = [...units.values()].map((u) => ({
    ...u,
    title: u.title ?? u.path,
    technology: [...u.technology].sort(),
    evidence: u.evidence.sort(byKey((e) => JSON.stringify(e))),
  }));
  return { nodes, edges: [], findings, analyses, tools };
}

// Links between units, from evidence already in the snapshot: a code node belongs to the deepest
// unit whose path contains it; an import that crosses units is a depends-on link, and so is a
// package.json dependency on another unit's package name. Runtime links are never inferred here.
const MAX_EVIDENCE = 5;

export function linkUnits(root, snapshot) {
  const units = snapshot.nodes.filter((n) => n.kind === 'container').sort(byKey((u) => String(1e6 - u.path.length).padStart(7, '0') + u.path));
  if (!units.length) return [];
  const within = (file, dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`);
  const unitOf = (file) => units.find((u) => within(file, u.path));
  const fileOf = new Map(snapshot.nodes.filter((n) => ['file', 'vendored-file', 'go-package'].includes(n.kind)).map((n) => [n.id, n.kind === 'go-package' ? n.file : n.id]));
  const tests = new Set(snapshot.nodes.filter((n) => n.test).map((n) => n.id));
  const links = new Map();
  const link = (from, to) => {
    const k = `${from.id}\u0000${to.id}`;
    if (!links.has(k)) links.set(k, { source: from.id, target: to.id, kind: 'depends-on', relations: {}, testRelations: {}, evidence: [] });
    return links.get(k);
  };
  for (const e of snapshot.edges) {
    if (e.kind !== 'imports') continue;
    const sf = fileOf.get(e.source), tf = fileOf.get(e.target);
    if (sf === undefined || tf === undefined) continue;
    const su = unitOf(sf), tu = unitOf(tf);
    if (!su || !tu || su === tu) continue;
    const l = link(su, tu);
    const rel = e.typeOnly ? 'type-only' : e.dynamic ? 'lazy' : 'imports';
    l.relations[rel] = (l.relations[rel] ?? 0) + 1;
    if (tests.has(e.source)) l.testRelations[rel] = (l.testRelations[rel] ?? 0) + 1;
    l.evidence.push({ tool: 'archsieve', file: sf, detail: `imports ${tf}` });
  }
  const byName = new Map(units.filter((u) => u.technology.includes('node')).map((u) => [u.title, u]));
  for (const u of units) {
    const manifest = u.evidence.find((e) => e.tool === 'manifest' && e.file.endsWith('package.json'))?.file;
    if (!manifest) continue;
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(root, manifest), 'utf8')); } catch { continue; }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {}).sort()) {
        const target = byName.get(name);
        if (!target || target === u) continue;
        const l = link(u, target);
        l.relations['package-dependency'] = (l.relations['package-dependency'] ?? 0) + 1;
        l.evidence.push({ tool: 'manifest', file: manifest, detail: `${field}.${name}` });
      }
    }
  }
  return [...links.values()].map((l) => {
    const ev = [...new Map(l.evidence.map((x) => [JSON.stringify(x), x])).values()].sort(byKey((x) => JSON.stringify(x)));
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
    const { testRelations, ...rest } = l;
    return { ...rest, relations: sorted(l.relations), ...(Object.keys(testRelations).length ? { testRelations: sorted(testRelations) } : {}), evidence: ev.length > MAX_EVIDENCE ? [...ev.slice(0, MAX_EVIDENCE), { tool: 'archsieve', detail: `${ev.length - MAX_EVIDENCE} more` }] : ev };
  });
}
