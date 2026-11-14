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
// Per language: which files are read at all (a bare `spawn(` in a file that names no child-process
// module is someone else's), the call pattern (program expression, then the rest of the line), how
// a same-file constant is bound, and how a string literal is written.
const LANGS = {
  js: {
    gate: /child_process|['"](execa|cross-spawn)['"]/,
    call: /(?:^|[^\w$.]|\b(?:child_process|cp|childProcess)\.)(spawn|spawnSync|execFile|execFileSync|fork|execa|execaSync|execaNode)\s*\(\s*([^,)]*)([^;]*)/,
    consts: /\bconst\s+([\w$]+)\s*=\s*(['"`])([^'"`$]*)\2/g,
    literal: /^(['"`])([^'"`$]*)\1$/,
    args: /(['"`])([^'"`$\n]*)\1|\b([A-Za-z_$][\w$]*)\b/g,
    relation: () => 'child-process',
  },
  rust: {
    gate: /Command::new|\.sidecar\s*\(/,
    call: /(Command::new_sidecar|Command::new|\.sidecar)\s*\(\s*&?([^,)]*)(.*)/,
    consts: /\b(?:const|static)\s+([A-Za-z_]\w*)\s*:\s*&(?:'static\s+)?str\s*=\s*()"([^"\\]*)"/g,
    literal: /^()"([^"\\]*)"$/,
    args: /()"([^"\\\n]*)"|\b([A-Za-z_]\w*)\b/g,
    relation: (fn) => (/sidecar/.test(fn) ? 'sidecar' : 'child-process'),
  },
};
// Release binaries carry a target triple (Tauri sidecars) or .exe; the name is what comes before.
const programName = (s) => s.replace(/\.exe$/i, '').replace(/-(x86_64|aarch64|i686|armv7|arm64|universal)-[\w-]+$/, '');

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
      // `go build` at a module root names the binary after the last element of the module path.
      if (e.tool === 'manifest' && e.file?.endsWith('go.mod')) {
        try { add(/^module\s+(\S+)/m.exec(readFileSync(join(root, e.file), 'utf8'))?.[1].split('/').pop(), u); } catch { /* unreadable */ }
      }
    }
  }
  return names;
}

// One container for a program, or null: a path (relative to the calling file or to the root) that
// exists inside a container, or a name exactly one container answers to. A path that does not exist
// (build output such as target/release/x) falls back to its file name when it has no extension.
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
      const base = posix.basename(c);
      if (/\.(?!exe$)\w+$/i.test(base)) return null;
      return named(base);
    }
    return named(c);
  };
  function named(c) {
    const hits = names.get(programName(c));
    return hits?.size === 1 ? [...hits][0] : null;
  }
}

// Returns runtime-link edges (container -> container), unknown findings for unreadable call sites,
// and the analyses entry. Reads production JS/TS files already in the snapshot and the Rust files
// the scan lists (no Rust graph exists to take them from).
export function runtimeLinks(root, snapshot, { rustFiles = [] } = {}) {
  const units = snapshot.nodes.filter((n) => n.kind === 'container');
  const jsFiles = snapshot.nodes.filter((n) => n.kind === 'file' && !n.test && JS_FILE.test(n.id)).map((n) => n.id);
  const resolve = resolver(root, units, programNames(root, units));
  const deepest = [...units].sort(byKey((u) => String(1e6 - u.path.length).padStart(7, '0') + u.path));
  const links = new Map(), unresolved = new Map();
  let external = 0;
  const read = { js: 0, rust: 0 };
  const sources = [...jsFiles.map((f) => [f, LANGS.js, 'js']), ...rustFiles.map((f) => [f, LANGS.rust, 'rust'])];
  for (const [file, lang, name] of sources) {
    let text;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    if (!lang.gate.test(text)) continue;
    read[name]++;
    const consts = new Map([...text.matchAll(lang.consts)].map((m) => [m[1], m[3]]));
    const value = (expr) => lang.literal.exec(expr.trim())?.[2] ?? consts.get(expr.trim()) ?? null;
    const from = deepest.find((u) => within(file, u.path));
    text.split('\n').forEach((line, i) => {
      const m = lang.call.exec(line);
      if (!m || /^\s*(\/\/|\*)/.test(line)) return;
      const ev = { tool: TOOL, file, line: i + 1, detail: line.trim().slice(0, 160) };
      const program = value(m[2]);
      if (program === null) {
        if (!unresolved.has(file)) unresolved.set(file, []);
        unresolved.get(file).push(ev);
        return;
      }
      const args = [...m[3].matchAll(lang.args)].map((a) => a[2] ?? consts.get(a[3])).filter((a) => a !== undefined);
      const target = [program, ...args].map((c) => resolve(c, file)).find(Boolean);
      if (!target) { external++; return; }
      if (!from || target === from) return;
      const k = `${from.id}\u0000${target.id}`;
      if (!links.has(k)) links.set(k, { source: from.id, target: target.id, kind: 'runtime-link', relations: {}, confidence: 'pattern', evidence: [] });
      const l = links.get(k), rel = lang.relation(m[1]);
      l.relations[rel] = (l.relations[rel] ?? 0) + 1;
      l.evidence.push(ev);
    });
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  const edges = [...links.values()].map((l) => ({
    ...l,
    relations: sorted(l.relations),
    evidence: l.evidence.length > MAX_EVIDENCE ? [...l.evidence.slice(0, MAX_EVIDENCE), { tool: TOOL, detail: `${l.evidence.length - MAX_EVIDENCE} more` }] : l.evidence,
  }));
  const findings = [...unresolved].map(([file, ev]) => ({
    level: 'unknown', rule: 'runtime-call-unresolved', subjects: [file],
    message: `${ev.length === 1 ? 'A child-process call' : `${ev.length} child-process calls`} in ${file} run${ev.length === 1 ? 's' : ''} a program that is not a literal or a same-file constant: the runtime link, if any, is not visible statically.`,
    evidence: ev,
  }));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const nUnresolved = [...unresolved.values()].reduce((s, e) => s + e.length, 0);
  const analysis = { tool: TOOL, scope: 'child-process and sidecar calls', status: 'ok', note: `${plural(edges.length, 'runtime link', 'runtime links')}, ${plural(external, 'call site', 'call sites')} to programs outside the repository, ${nUnresolved} unresolved; read ${read.js} of ${jsFiles.length} production JS/TS files and ${read.rust} of ${plural(rustFiles.length, 'Rust file', 'Rust files')} that name a child-process API` };
  return { edges, findings, analysis };
}
