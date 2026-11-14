import { readFileSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { byKey } from '../util.mjs';

// Static runtime-link evidence from call sites, read line by line (ADR 0006). This is not a parser:
// it recognises child-process calls whose program is a string literal, or a const bound to one in
// the same file, and resolves that program to a container of the snapshot. Everything it cannot read
// is an unknown finding, never a guess; programs that match no container are outside the repository.
export const TOOL = 'archsieve patterns';
const MAX_EVIDENCE = 5;
const JS_FILE = /\.(m|c)?(j|t)sx?$/;
// Only files that name a child-process module are read; a bare `spawn(` elsewhere is someone else's.
const JS_GATE = /child_process|['"](execa|cross-spawn)['"]/;
const JS_CALL = /(^|[^\w$.]|\b(?:child_process|cp|childProcess)\.)(spawn|spawnSync|execFile|execFileSync|fork|execa|execaSync|execaNode)\s*\(\s*([^,)]*)([^;]*)/;
const CONST = /\bconst\s+([\w$]+)\s*=\s*(['"`])([^'"`$]*)\2/g;
const LITERAL = /^(['"`])([^'"`$]*)\1$/;
const ARG_LITERALS = /(['"`])([^'"`$\n]*)\1|\b([A-Za-z_$][\w$]*)\b/g;

const within = (file, dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`);

// Names a container answers to when a program is called by name: package.json bin keys, Cargo bin
// targets, a Go main package's directory name, and the unscoped package name.
function programNames(root, units) {
  const names = new Map();
  const add = (name, u) => {
    if (!name) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(u);
  };
  for (const u of units) {
    for (const e of u.evidence) {
      if (e.tool === 'manifest' && e.file?.endsWith('package.json')) {
        try {
          const pkg = JSON.parse(readFileSync(join(root, e.file), 'utf8'));
          if (typeof pkg.bin === 'string') add(pkg.name?.replace(/^@[^/]+\//, ''), u);
          else for (const k of Object.keys(pkg.bin ?? {})) add(k, u);
          add(pkg.name?.replace(/^@[^/]+\//, ''), u);
        } catch { /* unreadable manifests are already reported by the units adapter */ }
      }
      if (e.tool === 'cargo metadata' && e.detail?.startsWith('bin ')) for (const b of e.detail.slice(4).split(',')) add(b, u);
      if (e.tool === 'go list' && e.detail === 'package main') add(posix.basename(u.path), u);
    }
  }
  return names;
}

// One container for a program, or null: a path (relative to the calling file or to the root) that
// exists inside a container, or a name exactly one container answers to.
function resolver(root, units, names) {
  const deepest = [...units].sort(byKey((u) => String(1e6 - u.path.length).padStart(7, '0') + u.path));
  const unitOf = (file) => deepest.find((u) => within(file, u.path));
  return (candidate, fromFile) => {
    const c = candidate.trim();
    if (!c || /\s/.test(c)) return null;
    if (c.includes('/') || /\.\w+$/.test(c)) {
      for (const p of [posix.normalize(posix.join(posix.dirname(fromFile), c)), posix.normalize(c.replace(/^\.\//, ''))]) {
        if (!p.startsWith('..') && !p.startsWith('/') && existsSync(join(root, p))) return unitOf(p) ?? null;
      }
      return null;
    }
    const hits = names.get(c.replace(/\.exe$/i, ''));
    return hits?.size === 1 ? [...hits][0] : null;
  };
}

// Returns runtime-link edges (container -> container), unknown findings for unreadable call sites,
// and the analyses entry. Reads only production source files already in the snapshot.
export function runtimeLinks(root, snapshot) {
  const units = snapshot.nodes.filter((n) => n.kind === 'container');
  const files = snapshot.nodes.filter((n) => n.kind === 'file' && !n.test && JS_FILE.test(n.id)).map((n) => n.id);
  const resolve = resolver(root, units, programNames(root, units));
  const deepest = [...units].sort(byKey((u) => String(1e6 - u.path.length).padStart(7, '0') + u.path));
  const links = new Map(), unresolved = new Map();
  let external = 0, read = 0;
  for (const file of files) {
    let text;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    if (!JS_GATE.test(text)) continue;
    read++;
    const consts = new Map([...text.matchAll(CONST)].map((m) => [m[1], m[3]]));
    const value = (expr) => LITERAL.exec(expr.trim())?.[2] ?? consts.get(expr.trim()) ?? null;
    const from = deepest.find((u) => within(file, u.path));
    text.split('\n').forEach((line, i) => {
      const m = JS_CALL.exec(line);
      if (!m || /^\s*(\/\/|\*)/.test(line)) return;
      const ev = { tool: TOOL, file, line: i + 1, detail: line.trim().slice(0, 160) };
      const program = value(m[3]);
      if (program === null) {
        if (!unresolved.has(file)) unresolved.set(file, []);
        unresolved.get(file).push(ev);
        return;
      }
      const args = [...m[4].matchAll(ARG_LITERALS)].map((a) => a[2] ?? consts.get(a[3])).filter((a) => a !== undefined);
      const target = [program, ...args].map((c) => resolve(c, file)).find(Boolean);
      if (!target) { external++; return; }
      if (!from || target === from) return;
      const k = `${from.id}\u0000${target.id}`;
      if (!links.has(k)) links.set(k, { source: from.id, target: target.id, kind: 'runtime-link', relations: { 'child-process': 0 }, confidence: 'pattern', evidence: [] });
      const l = links.get(k);
      l.relations['child-process']++;
      l.evidence.push(ev);
    });
  }
  const edges = [...links.values()].map((l) => ({
    ...l,
    evidence: l.evidence.length > MAX_EVIDENCE ? [...l.evidence.slice(0, MAX_EVIDENCE), { tool: TOOL, detail: `${l.evidence.length - MAX_EVIDENCE} more` }] : l.evidence,
  }));
  const findings = [...unresolved].map(([file, ev]) => ({
    level: 'unknown', rule: 'runtime-call-unresolved', subjects: [file],
    message: `${ev.length === 1 ? 'A child-process call' : `${ev.length} child-process calls`} in ${file} run${ev.length === 1 ? 's' : ''} a program that is not a literal or a same-file const: the runtime link, if any, is not visible statically.`,
    evidence: ev,
  }));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const nUnresolved = [...unresolved.values()].reduce((s, e) => s + e.length, 0);
  const analysis = { tool: TOOL, scope: 'child-process calls', status: 'ok', note: `${plural(edges.length, 'runtime link', 'runtime links')}, ${plural(external, 'call site', 'call sites')} to programs outside the repository, ${nUnresolved} unresolved; ${read} of ${files.length} production source files name a child-process module` };
  return { edges, findings, analysis };
}
