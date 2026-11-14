import { fileURLToPath } from 'node:url';
import { run, cycles } from '../util.mjs';

const PROBE = fileURLToPath(new URL('./nest-probe.cjs', import.meta.url));

export function scanNest(root, entry, exportName) {
  const res = run(process.execPath, [PROBE, entry, exportName], { cwd: root });
  if (res.status !== 0) {
    const err = new Error(`Nest graph extraction failed: ${res.stderr.trim().split('\n')[0]}`);
    err.code = 'TOOL_FAILED';
    throw err;
  }
  const { version, graph } = JSON.parse(res.stdout);
  return { version, ...normalize(graph) };
}

export function normalize(graph) {
  const tool = '@nestjs/core SerializedGraph (preview)';
  const nodes = new Map(), edges = [], findings = [];
  const byNestId = new Map();
  for (const n of Object.values(graph.nodes)) {
    const m = n.metadata;
    if (m.internal || n.label === 'InternalCoreModule') continue;
    const id = m.type === 'module' ? `nest:module:${n.label}` : `nest:${m.type}:${m.sourceModuleName}/${n.label}`;
    byNestId.set(n.id, id);
    const node = { id, kind: m.type === 'module' ? 'nest-module' : `nest-${m.type}`, evidence: [{ tool }] };
    if (m.type !== 'module') {
      node.module = `nest:module:${m.sourceModuleName}`;
      if (m.exported) node.exported = true;
      if (typeof m.token === 'string' || typeof m.token === 'symbol') node.token = String(m.token);
      if (m.scope !== undefined && m.scope !== 0) node.scope = m.scope;
    }
    nodes.set(id, node);
  }
  for (const e of Object.values(graph.edges)) {
    const m = e.metadata;
    const s = byNestId.get(e.source), t = byNestId.get(e.target);
    if (m.internal || !s || !t) continue;
    if (m.type === 'module-to-module') edges.push({ source: s, target: t, kind: 'nest-imports', evidence: [{ tool }] });
    else edges.push({ source: s, target: t, kind: 'nest-injects', injection: m.injectionType, ...(typeof m.targetClassToken === 'string' ? { token: m.targetClassToken } : {}), evidence: [{ tool }] });
  }
  // Heuristics (signals, never errors).
  const tokenCount = new Map();
  for (const n of nodes.values()) if (n.token) tokenCount.set(n.token, (tokenCount.get(n.token) ?? 0) + 1);
  for (const n of nodes.values()) {
    if (!n.token) continue;
    const label = n.id.split('/').pop();
    if (label !== n.token) {
      findings.push({ level: 'signal', rule: 'token-indirection', subjects: [n.id],
        message: `${label} is bound behind token "${n.token}" with ${tokenCount.get(n.token)} binding(s) in this graph. Check that the indirection answers a real need (multiple implementations, test seam, boundary).`,
        evidence: [{ tool }] });
    } else {
      findings.push({ level: 'unknown', rule: 'non-class-provider', subjects: [n.id],
        message: `Provider "${n.token}" is a value/factory/alias provider; what it returns and depends on is not visible in the DI graph.`, evidence: [{ tool }] });
    }
  }
  for (const kind of ['nest-injects', 'nest-imports']) {
    for (const comp of cycles(edges.filter((e) => e.kind === kind))) {
      findings.push({ level: 'error', rule: kind === 'nest-injects' ? 'di-cycle' : 'module-cycle', subjects: comp,
        message: `${kind === 'nest-injects' ? 'Provider injection' : 'Module import'} cycle among ${comp.join(', ')} (resolvable at runtime only through forwardRef).`, evidence: [{ tool }] });
    }
  }
  return { nodes: [...nodes.values()], edges, findings };
}
