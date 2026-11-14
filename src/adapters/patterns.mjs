import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { byKey } from '../util.mjs';
import { HTTP_GATE, serverRoutes, clientCall, routeMatch } from './routes.mjs';

export { serverRoutes, clientPath, routeMatch } from './routes.mjs';

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
    // The running Node binary: the program is node, so its literal arguments say what it runs.
    known: { 'process.execPath': 'node', 'process.argv[0]': 'node' },
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

// The file a literal names by path (relative to the calling file, to its container, where a process
// usually starts, or to the root), or null.
function fileAt(root, c, fromFile, unitPath = '.') {
  if (!c || /\s/.test(c) || !(c.includes('/') || /\.\w+$/.test(c))) return null;
  for (const p of [posix.normalize(posix.join(posix.dirname(fromFile), c)), posix.normalize(posix.join(unitPath, c)), posix.normalize(c.replace(/^\.\//, ''))]) {
    try { if (!p.startsWith('..') && !p.startsWith('/') && statSync(join(root, p)).isFile()) return p; } catch { /* not there */ }
  }
  return null;
}

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
export function runtimeLinks(root, snapshot, { rustFiles = [], goFiles = [] } = {}) {
  const units = snapshot.nodes.filter((n) => n.kind === 'container');
  const jsFiles = snapshot.nodes.filter((n) => n.kind === 'file' && !n.test && JS_FILE.test(n.id)).map((n) => n.id);
  const resolve = resolver(root, units, programNames(root, units));
  const deepest = [...units].sort(byKey((u) => String(1e6 - u.path.length).padStart(7, '0') + u.path));
  const links = new Map(), unresolved = new Map();
  const addLink = (from, target, rel, evidence) => {
    const k = `${from.id}\u0000${target.id}`;
    if (!links.has(k)) links.set(k, { source: from.id, target: target.id, kind: 'runtime-link', relations: {}, confidence: 'pattern', evidence: [] });
    const l = links.get(k);
    l.relations[rel] = (l.relations[rel] ?? 0) + 1;
    l.evidence.push(...evidence);
  };
  let external = 0;
  const spawned = [];
  const read = { js: 0, rust: 0 };
  const routes = [], calls = [];
  const sources = [...jsFiles.map((f) => [f, 'js']), ...rustFiles.map((f) => [f, 'rust']), ...goFiles.map((f) => [f, 'go'])];
  for (const [file, name] of sources) {
    const lang = LANGS[name];
    let text;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    const processes = lang?.gate.test(text), http = HTTP_GATE[name].test(text);
    if (!processes && !http) continue;
    const from = deepest.find((u) => within(file, u.path));
    const lines = text.split('\n');
    const evOf = (i) => ({ tool: TOOL, file, line: i + 1, detail: lines[i].trim().slice(0, 160) });
    const comment = (line) => /^\s*(\/\/|\*|#(?!\[))/.test(line);
    if (http && from) {
      const nestPrefix = name === 'js' ? /@Controller\s*\(\s*(?:(['"`])([^'"`]*)\1)?\s*\)/.exec(text)?.[2] ?? (/@Controller\b/.test(text) ? '' : undefined) : undefined;
      lines.forEach((line, i) => {
        if (comment(line)) return;
        const defined = serverRoutes(name, line, { nestPrefix });
        for (const path of defined) routes.push({ unit: from, path, ev: evOf(i) });
        const call = defined.length ? undefined : clientCall(name, line);
        if (call) calls.push({ unit: from, path: call.path, ev: evOf(i) });
      });
    }
    if (!processes) continue;
    read[name]++;
    const consts = new Map([...text.matchAll(lang.consts)].map((m) => [m[1], m[3]]));
    const value = (expr) => lang.literal.exec(expr.trim())?.[2] ?? consts.get(expr.trim()) ?? lang.known?.[expr.trim()] ?? null;
    lines.forEach((line, i) => {
      const m = lang.call.exec(line);
      if (!m || comment(line)) return;
      const ev = evOf(i);
      const program = value(m[2]);
      if (program === null) {
        if (!unresolved.has(file)) unresolved.set(file, []);
        unresolved.get(file).push(ev);
        return;
      }
      const args = [...m[3].matchAll(lang.args)].map((a) => a[2] ?? consts.get(a[3])).filter((a) => a !== undefined);
      for (const c of [program, ...args]) {
        const f = fileAt(root, c, file, from?.path);
        if (f) spawned.push({ file: f, by: ev });
      }
      const target = [program, ...args].map((c) => resolve(c, file)).find(Boolean);
      if (!target) { external++; return; }
      if (!from || target === from) return;
      addLink(from, target, lang.relation(m[1]), [ev]);
    });
  }
  // A client call is a link only when its path matches routes of exactly one other container.
  const http = { matched: 0, ambiguous: 0, noRoute: 0, noLiteral: 0 };
  for (const c of calls) {
    if (c.path === null) { http.noLiteral++; continue; }
    const hits = routes.filter((r) => routeMatch(r.path, c.path));
    const targets = [...new Set(hits.map((r) => r.unit))];
    if (!targets.length) http.noRoute++;
    else if (targets.includes(c.unit)) continue;
    else if (targets.length > 1) http.ambiguous++;
    else {
      http.matched++;
      addLink(c.unit, targets[0], 'http-route', [c.ev, hits[0].ev]);
    }
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  const edges = [...links.values()].map((l) => {
    const ev = [...new Map(l.evidence.map((x) => [`${x.file}:${x.line}`, x])).values()].sort(byKey((x) => `${x.file}\u0000${String(x.line).padStart(9, '0')}`));
    return { ...l, relations: sorted(l.relations), evidence: ev.length > MAX_EVIDENCE ? [...ev.slice(0, MAX_EVIDENCE), { tool: TOOL, detail: `${ev.length - MAX_EVIDENCE} more` }] : ev };
  });
  const findings = [...unresolved].map(([file, ev]) => ({
    level: 'unknown', rule: 'runtime-call-unresolved', subjects: [file],
    message: `${ev.length === 1 ? 'A child-process call' : `${ev.length} child-process calls`} in ${file} run${ev.length === 1 ? 's' : ''} a program that is not a literal or a same-file constant: the runtime link, if any, is not visible statically.`,
    evidence: ev,
  }));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const nUnresolved = [...unresolved.values()].reduce((s, e) => s + e.length, 0);
  const routeUnits = new Set(routes.map((r) => r.unit)).size;
  const analysis = {
    tool: TOOL, scope: 'child-process, sidecar and HTTP calls', status: 'ok',
    note: `${plural(edges.length, 'runtime link', 'runtime links')}, ${plural(external, 'call site', 'call sites')} to programs outside the repository, ${nUnresolved} unresolved; read ${read.js} of ${jsFiles.length} production JS/TS files and ${read.rust} of ${plural(rustFiles.length, 'Rust file', 'Rust files')} that name a child-process API`
      + `; HTTP: ${plural(routes.length, 'route', 'routes')} in ${plural(routeUnits, 'container', 'containers')}; ${plural(http.matched, 'call', 'calls')} matched, ${http.ambiguous} ambiguous, ${http.noRoute} matched no route, ${http.noLiteral} without a literal path`,
  };
  return { edges, findings, analysis, spawned };
}
