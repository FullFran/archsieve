import { byKey } from './util.mjs';

// A diagram is a VIEW of the snapshot, never the source of truth. Every rendered
// node/edge comes from the snapshot; nothing is added or inferred here.

const CODE_KINDS = new Set(['file', 'go-package', 'vendored-file']);

function componentOf(node, depth) {
  const path = node.kind === 'file' ? node.id.split('/').slice(0, -1) : (node.file ?? '.').split('/');
  const segs = path.filter((s) => s && s !== '.');
  return segs.length ? segs.slice(0, depth).join('/') : '(root)';
}

export function project(snapshot, { view = 'components', depth = 2, externals = false } = {}) {
  const nodes = new Map(), edges = new Map();
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  let mapNode;
  if (view === 'nest') {
    mapNode = (n) => (n.kind.startsWith('nest-') ? { id: n.id, label: n.id.split(/[:/]/).pop(), group: n.kind === 'nest-module' ? null : n.module, kind: n.kind } : null);
  } else if (view === 'files') {
    mapNode = (n) => (CODE_KINDS.has(n.kind) ? { id: n.id, label: n.id.replace(/^go:/, ''), kind: n.kind } : externals && n.kind === 'external-package' ? { id: n.id, label: n.id, kind: n.kind } : null);
  } else {
    mapNode = (n) => {
      if (CODE_KINDS.has(n.kind)) { const c = componentOf(n, depth); return { id: `dir:${c}`, label: c, kind: 'component' }; }
      return externals && n.kind === 'external-package' ? { id: n.id, label: n.id, kind: n.kind } : null;
    };
  }
  for (const n of snapshot.nodes) { const m = mapNode(n); if (m && !nodes.has(m.id)) nodes.set(m.id, m); }
  for (const e of snapshot.edges) {
    if (view === 'nest' ? !e.kind.startsWith('nest-') : e.kind !== 'imports') continue;
    const s = nodeById.get(e.source) && mapNode(nodeById.get(e.source));
    const t = nodeById.get(e.target) && mapNode(nodeById.get(e.target));
    if (!s || !t || s.id === t.id) continue;
    const k = `${s.id}\u0000${t.id}\u0000${e.kind}`;
    const prev = edges.get(k);
    edges.set(k, { source: s.id, target: t.id, kind: e.kind, count: (prev?.count ?? 0) + 1 });
  }
  return { nodes: [...nodes.values()].sort(byKey((n) => n.id)), edges: [...edges.values()].sort(byKey((e) => `${e.source}\u0000${e.target}\u0000${e.kind}`)) };
}

// Merge two projections and tag each element as added / removed / same.
export function compareProjections(before, after) {
  const tag = (bs, as, key) => {
    const b = new Map(bs.map((x) => [key(x), x])), a = new Map(as.map((x) => [key(x), x]));
    const out = as.map((x) => ({ ...x, status: b.has(key(x)) ? 'same' : 'added' }));
    for (const x of bs) if (!a.has(key(x))) out.push({ ...x, status: 'removed' });
    return out.sort(byKey(key));
  };
  const ek = (e) => `${e.source}\u0000${e.target}\u0000${e.kind}`;
  return { nodes: tag(before.nodes, after.nodes, (n) => n.id), edges: tag(before.edges, after.edges, ek) };
}

const q = (s) => String(s).replace(/"/g, '#quot;');

export function toMermaid(p, { title } = {}) {
  const ids = new Map(p.nodes.map((n, i) => [n.id, `n${i}`]));
  const L = ['flowchart LR'];
  if (title) L.unshift('---', `title: ${q(title)}`, '---');
  const groups = new Map();
  for (const n of p.nodes) { const g = n.group ?? ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); }
  const emit = (n, indent) => {
    const shape = n.kind === 'nest-module' ? `[["${q(n.label)}"]]` : n.kind === 'external-package' ? `(["${q(n.label)}"])` : `["${q(n.label)}"]`;
    L.push(`${indent}${ids.get(n.id)}${shape}${n.status && n.status !== 'same' ? `:::${n.status}` : ''}`);
  };
  // A node that owns members (a Nest module) is drawn AS the subgraph, so edges can target it directly.
  const nodeById = new Map(p.nodes.map((n) => [n.id, n]));
  for (const n of groups.get('') ?? []) if (!groups.has(n.id)) emit(n, '  ');
  for (const [g, ns] of [...groups.entries()].sort(byKey(([g]) => g))) {
    if (!g) continue;
    const owner = nodeById.get(g);
    L.push(`  subgraph ${ids.get(g) ?? `g_${ids.size}`}["${q(owner?.label ?? g.split(':').pop())}"]`);
    ns.forEach((n) => emit(n, '    '));
    L.push('  end');
    if (owner?.status && owner.status !== 'same') L.push(`  class ${ids.get(g)} ${owner.status}`);
  }
  const linkStyles = [];
  p.edges.forEach((e, i) => {
    const label = [e.kind === 'nest-imports' ? 'imports' : e.kind === 'nest-injects' ? 'injects' : '', e.count > 1 ? `${e.count}` : ''].filter(Boolean).join(' x');
    const arrow = e.kind === 'nest-imports' ? '-.->' : e.status === 'removed' ? '-.->' : '-->';
    L.push(`  ${ids.get(e.source)} ${arrow}${label ? `|"${q(label)}"|` : ''} ${ids.get(e.target)}`);
    if (e.status === 'added') linkStyles.push(`  linkStyle ${i} stroke:#2da44e,stroke-width:3px`);
    if (e.status === 'removed') linkStyles.push(`  linkStyle ${i} stroke:#cf222e,stroke-width:2px`);
  });
  L.push(...linkStyles);
  if (p.nodes.some((n) => n.status)) {
    L.push('  classDef added fill:#dafbe1,stroke:#2da44e,stroke-width:2px', '  classDef removed fill:#ffebe9,stroke:#cf222e,stroke-dasharray:4 3');
  }
  return `${L.join('\n')}\n`;
}

const dq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function toDot(p, { title } = {}) {
  const L = ['digraph archsieve {', '  rankdir=LR;', '  node [shape=box, fontname="Helvetica"];'];
  if (title) L.push(`  label=${dq(title)}; labelloc=t;`);
  const color = (s) => (s === 'added' ? ', color="#2da44e", penwidth=2' : s === 'removed' ? ', color="#cf222e", style=dashed' : '');
  const groups = new Map();
  for (const n of p.nodes) { const g = n.group ?? ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); }
  let gi = 0;
  // DOT clusters cannot be edge endpoints: the owning node is drawn inside its own cluster.
  const owners = new Set([...groups.keys()].filter(Boolean));
  if (groups.has('')) groups.set('', groups.get('').filter((n) => !owners.has(n.id)));
  for (const g of owners) groups.get(g).unshift(...p.nodes.filter((n) => n.id === g));
  for (const [g, ns] of [...groups.entries()].sort(byKey(([g]) => g))) {
    const ind = g ? '    ' : '  ';
    if (g) L.push(`  subgraph cluster_${gi++} {`, `    label=${dq(g.split(':').pop())};`);
    for (const n of ns) L.push(`${ind}${dq(n.id)} [label=${dq(n.label)}${n.kind === 'external-package' ? ', shape=ellipse' : n.kind === 'nest-module' ? ', shape=component' : ''}${color(n.status)}];`);
    if (g) L.push('  }');
  }
  for (const e of p.edges) {
    const label = e.count > 1 ? `, label="${e.count}"` : '';
    L.push(`  ${dq(e.source)} -> ${dq(e.target)} [${e.kind === 'nest-imports' ? 'style=dotted' : ''}${label}${color(e.status)}];`.replace('[,', '[').replace(' []', ''));
  }
  L.push('}');
  return `${L.join('\n')}\n`;
}
