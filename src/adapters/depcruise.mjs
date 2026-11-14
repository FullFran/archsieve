import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { run, canonicalCycle } from '../util.mjs';

// The package does not export ./package.json: walk up from its resolved entry point.
let pkgDir = dirname(fileURLToPath(import.meta.resolve('dependency-cruiser')));
while (!existsSync(join(pkgDir, 'package.json')) || JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).name !== 'dependency-cruiser') pkgDir = dirname(pkgDir);
const PKG = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const BIN = join(pkgDir, typeof PKG.bin === 'string' ? PKG.bin : PKG.bin['depcruise']);
export const VERSION = PKG.version;

// Never applied inside node_modules: packages often resolve to their own dist/ or build/ files.
export const DEFAULT_EXCLUDE = '^(?!.*node_modules/).*(^|/)(dist|build|coverage|target|generated|\\.git)(/|$)';
// Vendored code is a boundary, not something to re-analyze: edges INTO it are kept, its insides are not followed.
export const VENDOR = '(^|/)(node_modules|vendor|third_party)(/|$)';

// ArchSieve does not define its own rule language: rules ARE dependency-cruiser rules.
// Only two defaults, both well understood. Severity maps to ArchSieve levels:
// error -> "error" (verifiable), warn -> "signal" (heuristic).
function defaultConfig({ exclude, tsConfig }) {
  return {
    forbidden: [
      { name: 'no-circular', severity: 'error', comment: 'Import cycle between source files.', from: {}, to: { circular: true } },
      { name: 'no-orphans', severity: 'warn', comment: 'File neither imports nor is imported. Entry points and scripts are legitimate orphans.',
        from: { orphan: true, pathNot: '\\.d\\.ts$' }, to: {} },
    ],
    options: {
      doNotFollow: { path: VENDOR },
      exclude: { path: exclude },
      // 'specify' keeps type-only imports but labels them 'pre-compilation-only' (erased at runtime).
      tsPreCompilationDeps: 'specify',
      ...(tsConfig ? { tsConfig: { fileName: tsConfig } } : {}),
    },
  };
}

export function scanDepcruise(root, { paths = ['.'], exclude = DEFAULT_EXCLUDE, tsConfig } = {}) {
  // Config is written outside the target repo, as JSON-in-CJS we generate ourselves.
  // We never load a JS config from the target repository (that would execute its code).
  const dir = mkdtempSync(join(tmpdir(), 'archsieve-dc-'));
  try {
    const cfg = join(dir, 'archsieve.depcruise.cjs');
    writeFileSync(cfg, `module.exports = ${JSON.stringify(defaultConfig({ exclude, tsConfig }), null, 2)};\n`);
    const res = run(process.execPath, [BIN, ...paths, '--config', cfg, '--output-type', 'json'], { cwd: root });
    if (!res.stdout.trim()) {
      const err = new Error(`dependency-cruiser produced no output: ${res.stderr.trim().slice(0, 500)}`);
      err.code = 'TOOL_FAILED';
      throw err;
    }
    return normalize(JSON.parse(res.stdout));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const npmName = (resolved, module) => {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(resolved ?? '');
  if (m) return m[1];
  const parts = module.split('/');
  return module.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

export function normalize(result) {
  const nodes = new Map(), edges = [], findings = [], unresolved = new Map();
  const tool = 'dependency-cruiser';
  for (const mod of result.modules) {
    // Unresolved specifiers also appear as pseudo-modules: they are reported as unknown findings, not nodes.
    if (mod.coreModule || mod.couldNotResolve || /node_modules\//.test(mod.source)) continue;
    const vendored = new RegExp(VENDOR).test(mod.source);
    if (!nodes.has(mod.source)) nodes.set(mod.source, { id: mod.source, kind: vendored ? 'vendored-file' : 'file', evidence: [{ tool }] });
    if (vendored) continue;
    for (const d of mod.dependencies) {
      if (d.coreModule) continue;
      const types = d.dependencyTypes ?? [];
      let target;
      if (d.couldNotResolve) {
        // One finding per file (finding ids are rule + subjects), one evidence entry per specifier.
        let f = unresolved.get(mod.source);
        if (!f) unresolved.set(mod.source, f = { level: 'unknown', rule: 'unresolved-import', subjects: [mod.source], evidence: [] });
        f.evidence.push({ tool, file: mod.source, detail: d.module });
        continue;
      } else if (types.some((t) => t.startsWith('npm')) || /node_modules\//.test(d.resolved)) {
        target = `npm:${npmName(d.resolved, d.module)}`;
        if (!nodes.has(target)) nodes.set(target, { id: target, kind: 'external-package', evidence: [{ tool }] });
      } else {
        target = d.resolved;
      }
      edges.push({
        source: mod.source, target, kind: 'imports',
        ...(types.includes('type-only') || types.includes('pre-compilation-only') ? { typeOnly: true } : {}),
        ...(d.dynamic ? { dynamic: true } : {}),
        evidence: [{ tool, file: mod.source, detail: d.module }],
      });
    }
  }
  for (const f of unresolved.values()) {
    const specs = [...new Set(f.evidence.map((e) => e.detail))].sort();
    f.evidence = specs.map((detail) => ({ tool, file: f.subjects[0], detail }));
    f.message = `${specs.length > 1 ? `${specs.length} imports` : 'Import'} ${specs.map((x) => `"${x}"`).join(', ')} could not be resolved statically (alias, generated file, missing dependency or dynamic path).`;
    findings.push(f);
  }
  // Cycles: dependency-cruiser reports one violation per edge in a cycle; collapse to one finding per cycle.
  const seen = new Set();
  for (const v of result.summary.violations ?? []) {
    if (v.rule.name === 'no-circular') {
      const path = (v.cycle ?? []).map((c) => (typeof c === 'string' ? c : c.name));
      const cyc = canonicalCycle(path);
      const id = cyc.join(' -> ');
      if (seen.has(id)) continue;
      seen.add(id);
      const typeOnly = cyc.some((from, i) => edges.find((e) => e.source === from && e.target === cyc[(i + 1) % cyc.length])?.typeOnly);
      if (typeOnly) {
        findings.push({ level: 'signal', rule: 'type-only-cycle', subjects: cyc,
          message: `Cycle exists only through type-only imports (erased at runtime; compile-time coupling): ${id} -> ${cyc[0]}`, evidence: [{ tool, file: v.from }] });
      } else {
        findings.push({ level: 'error', rule: 'no-circular', subjects: cyc, message: `Runtime import cycle: ${id} -> ${cyc[0]}`, evidence: [{ tool, file: v.from }] });
      }
    } else {
      findings.push({
        level: v.rule.severity === 'error' ? 'error' : 'signal', rule: v.rule.name, subjects: [v.from],
        message: v.rule.name === 'no-orphans' ? `${v.from} has no static importers or imports (entry point, script or dead file?).` : `${v.rule.name}: ${v.from} -> ${v.to}`,
        evidence: [{ tool, file: v.from }],
      });
    }
  }
  return { nodes: [...nodes.values()], edges, findings };
}
