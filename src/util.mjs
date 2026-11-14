import { spawnSync } from 'node:child_process';

// Run a command without a shell. Never inherits stdin; never runs repo scripts.
export function run(cmd, args, { cwd, env, input, encoding = 'utf8', maxBuffer = 1024 * 1024 * 1024 } = {}) {
  const res = spawnSync(cmd, args, { cwd, env: env ?? process.env, encoding: encoding === 'buffer' ? undefined : encoding, maxBuffer, input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  if (res.error) {
    const err = new Error(`${cmd}: ${res.error.code === 'ENOENT' ? 'command not found' : res.error.message}`);
    err.code = res.error.code === 'ENOENT' ? 'TOOL_MISSING' : 'TOOL_FAILED';
    throw err;
  }
  return res;
}

export const byKey = (key) => (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

export const edgeKey = (e) => `${e.source}\u0000${e.target}\u0000${e.kind}`;

// Canonical rotation so the same cycle always gets the same id.
export function canonicalCycle(nodes) {
  let best = 0;
  for (let i = 1; i < nodes.length; i++) if (nodes[i] < nodes[best]) best = i;
  return [...nodes.slice(best), ...nodes.slice(0, best)];
}

// Strongly connected components (Tarjan). Used only where the analyzer
// itself does not report cycles (Nest SerializedGraph, go list).
export function cycles(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source).push(e.target);
  }
  let index = 0;
  const idx = new Map(), low = new Map(), stack = [], on = new Set(), out = [];
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of (adj.get(v) ?? []).sort()) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const v of [...adj.keys()].sort()) if (!idx.has(v)) strong(v);
  return out;
}
