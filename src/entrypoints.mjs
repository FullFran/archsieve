import { readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { globToRegExp } from './tests.mjs';

// Files something runs by path, read as data and never executed (#21): package.json main/module/
// browser/bin/exports, --entry-globs, package.json scripts, and node-like commands in Dockerfiles,
// systemd units, Procfiles, shell and PowerShell scripts and GitHub workflow `run:` steps, plus files
// production code spawns by path (ADR 0006 call-site patterns). Each entry keeps its reason and the
// file and line that run it, so a suppressed signal can be audited.
const MAX_READ = 1024 * 1024;
const RUNNERS = new Set(['node', 'nodejs', 'tsx', 'ts-node', 'ts-node-esm', 'bun', 'deno', 'babel-node', 'esno', 'vite-node']);
const SCRIPT = /\.(m|c)?(j|t)sx?$/;

// Which tracked files hold commands, and which of their lines are commands.
const COMMAND_SOURCES = [
  { reason: 'Dockerfile command', file: (f) => /^Dockerfile/.test(posix.basename(f)) || f.endsWith('.dockerfile'), line: (l) => /^\s*(CMD|ENTRYPOINT|RUN)\b/i.test(l) },
  { reason: 'systemd unit', file: (f) => f.endsWith('.service'), line: (l) => /^\s*Exec\w*\s*=/.test(l) },
  { reason: 'Procfile', file: (f) => posix.basename(f) === 'Procfile', line: (l) => /^\s*[\w-]+\s*:/.test(l) },
  { reason: 'shell script', file: (f) => /\.(sh|bash|zsh|ps1|psm1)$/.test(f), line: (l) => !/^\s*#/.test(l) },
  { reason: 'workflow run step', file: (f) => /^(.*\/)?\.github\/workflows\/[^/]+\.ya?ml$/.test(f), line: null },
];

// 0-based line of a JSON key at or after line `from`, or -1.
const keyLine = (lines, name, from = 0) => {
  const key = new RegExp(`(^|[{,\\s])${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  return lines.findIndex((l, n) => n >= from && key.test(l));
};
const at = (i) => (i === -1 ? {} : { line: i + 1 });

const read = (root, f) => {
  try { return statSync(join(root, f)).size > MAX_READ ? null : readFileSync(join(root, f), 'utf8'); } catch { return null; }
};

// Script paths a command line runs with a node-like runner: every argument after the runner that
// names a tracked script (so `node --import ./setup.mjs server.mjs` yields both).
function commandTargets(command) {
  const out = [];
  for (const segment of command.split(/&&|\|\||[;|]/)) {
    const tokens = segment.replace(/[[\]",']/g, ' ').split(/\s+/).filter(Boolean);
    const at = tokens.findIndex((t) => RUNNERS.has(posix.basename(t.replace(/\\/g, '/')).replace(/\.exe$/i, '')));
    if (at === -1) continue;
    for (const t of tokens.slice(at + 1)) if (SCRIPT.test(t)) out.push(t.replace(/\\/g, '/'));
  }
  return out;
}

// A tracked file for a path: relative to `dir`, then to the root; with `deployed`, an absolute or
// otherwise unknown path (a container or server layout) matches the longest suffix of at least two
// segments that one tracked file ends with, or the nearest to the declaring file when several do.
function resolver(tracked, files) {
  return (p, dir, deployed) => {
    const rel = p.replace(/^(\.\/)+/, '');
    if (!p.startsWith('/')) {
      for (const c of [posix.normalize(posix.join(dir, rel)), posix.normalize(rel)]) if (tracked.has(c)) return c;
    }
    if (!deployed) return null;
    const segs = rel.replace(/^\/+/, '').split('/');
    // Several matches: the one sharing the longest folder prefix with the declaring file, if unique.
    const shared = (f) => {
      const x = f.split('/'), y = dir.split('/');
      let n = 0;
      while (n < x.length - 1 && n < y.length && x[n] === y[n]) n++;
      return n;
    };
    for (let i = 0; i <= segs.length - 2; i++) {
      const suffix = segs.slice(i).join('/');
      const hits = files.filter((f) => f === suffix || f.endsWith(`/${suffix}`));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        const best = Math.max(...hits.map(shared));
        const near = hits.filter((f) => shared(f) === best);
        return best > 0 && near.length === 1 ? near[0] : null;
      }
    }
    return null;
  };
}

export function entryPoints(root, files, { snapshot, spawned = [], entryGlobs = [] } = {}) {
  const tracked = new Set(files);
  const resolve = resolver(tracked, files);
  const entries = new Map();
  const add = (file, reason, evidence) => { if (file && !entries.has(file)) entries.set(file, { reason, evidence: { tool: 'archsieve', ...evidence } }); };

  // Manifest entry fields of each container's package.json.
  for (const u of snapshot.nodes.filter((n) => n.kind === 'container')) {
    const manifest = u.evidence.find((e) => e.tool === 'manifest' && e.file?.endsWith('package.json'))?.file;
    const text = manifest && read(root, manifest);
    const pkg = text && (() => { try { return JSON.parse(text); } catch { return null; } })();
    if (!pkg) continue;
    const dir = posix.dirname(manifest), lines = text.split('\n');
    const walk = (field, v) => {
      if (typeof v === 'string') add(posix.normalize(posix.join(dir, v)), 'manifest entry', { file: manifest, ...at(keyLine(lines, field)), detail: field });
      else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(field, x);
    };
    for (const field of ['main', 'module', 'browser', 'bin', 'exports']) walk(field, pkg[field]);
  }
  const globs = entryGlobs.map((g) => [g, globToRegExp(g)]);
  for (const f of files) {
    const g = globs.find(([, re]) => re.test(f));
    if (g) add(f, 'entry glob', { detail: `--entry-globs ${g[0]}` });
  }
  // package.json scripts, in any tracked package.json.
  for (const manifest of files.filter((f) => posix.basename(f) === 'package.json')) {
    const text = read(root, manifest);
    let scripts;
    try { scripts = JSON.parse(text)?.scripts; } catch { continue; }
    if (!scripts || typeof scripts !== 'object') continue;
    const lines = text.split('\n');
    const from = Math.max(0, keyLine(lines, 'scripts'));
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command !== 'string') continue;
      const i = keyLine(lines, name, from);
      for (const t of commandTargets(command)) add(resolve(t, posix.dirname(manifest), false), 'package.json script', { file: manifest, ...at(i), detail: `scripts.${name}: ${command}`.slice(0, 160) });
    }
  }
  // Command lines in deployment, service, CI and shell files.
  for (const f of files) {
    const source = COMMAND_SOURCES.find((s) => s.file(f));
    if (!source) continue;
    const text = read(root, f);
    if (!text) continue;
    const lines = text.split('\n');
    const commands = [];
    if (source.line) lines.forEach((l, i) => { if (source.line(l)) commands.push([i, l]); });
    else {
      // `run: cmd` or a `run: |` block whose lines are indented deeper than the key.
      for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(lines[i]);
        if (!m) continue;
        if (!/^[|>][-+]?\s*$/.test(m[2])) { commands.push([i, m[2]]); continue; }
        for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > m[1].length); j++) commands.push([j, lines[j]]);
      }
    }
    for (const [i, line] of commands) {
      for (const t of commandTargets(line)) add(resolve(t, posix.dirname(f), true), source.reason, { file: f, line: i + 1, detail: line.trim().slice(0, 160) });
    }
  }
  for (const s of spawned) add(tracked.has(s.file) ? s.file : null, 'spawned by path', { file: s.by.file, line: s.by.line, detail: s.by.detail });
  return entries;
}
