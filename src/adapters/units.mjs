import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { run, byKey } from '../util.mjs';

// Observed units (C4 containers and packages) from manifests. Manifests are read as data and
// never executed: JSON files are parsed, Cargo targets come from `cargo metadata --no-deps`
// (which does not run build scripts), Go main packages come from the go list adapter.
export const MANIFESTS = ['package.json', 'Cargo.toml', 'tauri.conf.json', 'go.mod'];

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
