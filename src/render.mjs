import { byKey } from './util.mjs';
import { withoutTests } from './tests.mjs';

// A diagram is a VIEW of the snapshot, never the source of truth. Every rendered
// node/edge comes from the snapshot; nothing is added or inferred here.

const CODE_KINDS = new Set(['file', 'go-package', 'vendored-file']);

function componentOf(node, depth, within) {
  const path = node.kind === 'file' ? node.id.split('/').slice(0, -1) : (node.file ?? '.').split('/');
  const segs = path.filter((s) => s && s !== '.');
  // Under --within the depth is counted below the zoomed folder.
  if (within) { const w = within.split('/'); return [...w, ...segs.slice(w.length, w.length + depth)].join('/'); }
  return segs.length ? segs.slice(0, depth).join('/') : '(root)';
}

// Where an element lives on disk (a file path, or a folder for packages); null when the snapshot does not say.
const whereOf = (n) => (n.kind === 'container' ? n.path : n.kind === 'file' ? n.id : n.file ?? (n.kind === 'go-package' ? n.id.replace(/^go:/, '') : null));

// An element outside the --within scope becomes one boundary box per top-level folder (or external package).
function boundaryOf(n) {
  if (n.kind === 'external-package') return { id: n.id, label: `${n.id} (external)`, kind: 'boundary' };
  const w = whereOf(n);
  const segs = w ? (n.kind === 'file' || n.kind.startsWith('nest-') ? w.split('/').slice(0, -1) : w.split('/')) : [];
  const top = segs.find((s) => s && s !== '.');
  return top ? { id: `out:${top}`, label: `${top}/ (outside)`, kind: 'boundary' } : { id: 'out:(root)', label: '(root files, outside)', kind: 'boundary' };
}

// A container box says what it is, where it lives, its technology and, with a declared model, its
// cross-check state in words (never colour alone).
const STATE_TEXT = { 'declared-unverified': 'declared, unverified', undeclared: 'in code, not in model' };
const LINK_STATE_TEXT = { 'declared-unverified': 'unverified', undeclared: 'not in model', 'code-dependency-only': 'code only, runtime unverified', evidenced: 'evidenced (static pattern)' };
function containerNode(n) {
  const group = n.declared?.parent ? `group:${n.declared.parent}` : null;
  if (n.kind === 'system') return { id: n.id, label: `${n.title}<br/>external system`, kind: 'system', group };
  const tech = n.declared?.technology ?? n.technology.join('+');
  const lines = [n.declared?.title ?? n.title, `${n.path}${tech ? ` · ${tech}` : ''}`, ...(STATE_TEXT[n.status] ? [STATE_TEXT[n.status]] : [])];
  return { id: n.id, label: lines.join('<br/>'), kind: 'container', group, ...(n.status ? { state: n.status } : {}), ...(n.facts ? { path: n.path, facts: n.facts } : {}) };
}

export function project(snapshot, { view = 'components', depth = 2, externals = false, within = null } = {}) {
  const nodes = new Map(), edges = new Map();
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  let mapNode;
  if (view === 'nest') {
    mapNode = (n) => (n.kind.startsWith('nest-') ? { id: n.id, label: n.id.split(/[:/]/).pop(), group: n.kind === 'nest-module' ? null : n.module, kind: n.kind } : null);
  } else if (view === 'containers') {
    mapNode = (n) => (n.kind === 'container' || n.kind === 'system' ? containerNode(n) : null);
  } else if (view === 'files') {
    mapNode = (n) => (CODE_KINDS.has(n.kind) ? { id: n.id, label: n.id.replace(/^go:/, ''), kind: n.kind } : externals && n.kind === 'external-package' ? { id: n.id, label: n.id, kind: n.kind } : null);
  } else {
    mapNode = (n) => {
      if (CODE_KINDS.has(n.kind)) { const c = componentOf(n, depth, within); return { id: `dir:${c}`, label: c, kind: 'component' }; }
      return externals && n.kind === 'external-package' ? { id: n.id, label: n.id, kind: n.kind } : null;
    };
  }
  if (within) {
    const inner = mapNode;
    mapNode = (n) => {
      const m = inner(n);
      if (!m) return null;
      const w = n.kind === 'external-package' ? null : whereOf(n);
      return w && (w === within || w.startsWith(`${within}/`)) ? m : boundaryOf(n);
    };
  }
  for (const n of snapshot.nodes) { const m = mapNode(n); if (m && !nodes.has(m.id)) nodes.set(m.id, m); }
  for (const e of snapshot.edges) {
    if (view === 'nest' ? !e.kind.startsWith('nest-') : view === 'containers' ? !['depends-on', 'runtime-link'].includes(e.kind) : e.kind !== 'imports') continue;
    const s = nodeById.get(e.source) && mapNode(nodeById.get(e.source));
    const t = nodeById.get(e.target) && mapNode(nodeById.get(e.target));
    if (!s || !t || s.id === t.id || (s.kind === 'boundary' && t.kind === 'boundary')) continue;
    const k = `${s.id}\u0000${t.id}\u0000${e.kind}`;
    if (e.kind === 'depends-on') {
      edges.set(k, { ...edges.get(k), source: s.id, target: t.id, kind: e.kind, relations: e.relations ?? {}, ...(e.testRelations ? { testRelations: e.testRelations } : {}), ...(e.declared ? { declared: e.declared } : {}), ...(e.status ? { state: e.status } : {}) });
      continue;
    }
    if (e.kind === 'runtime-link') {
      // Pattern evidence joins the arrow of the same pair instead of drawing a second one.
      const dk = `${s.id}\u0000${t.id}\u0000depends-on`;
      const prev = edges.get(dk) ?? { source: s.id, target: t.id, kind: 'depends-on', relations: {} };
      const runtime = { ...prev.runtime };
      for (const [r, n] of Object.entries(e.relations ?? {})) runtime[r] = (runtime[r] ?? 0) + n;
      edges.set(dk, { ...prev, runtime });
      continue;
    }
    const prev = edges.get(k);
    const relation = e.kind !== 'imports' ? e.kind : e.typeOnly ? 'type-only' : e.dynamic ? 'lazy' : 'imports';
    const relations = { ...prev?.relations, [relation]: (prev?.relations?.[relation] ?? 0) + 1 };
    const fromTest = nodeById.get(e.source).test;
    const testRelations = fromTest || prev?.testRelations ? { ...prev?.testRelations, ...(fromTest ? { [relation]: (prev?.testRelations?.[relation] ?? 0) + 1 } : {}) } : null;
    edges.set(k, { source: s.id, target: t.id, kind: e.kind, count: (prev?.count ?? 0) + 1, relations, ...(testRelations ? { testRelations } : {}) });
  }
  if (within) {
    const used = new Set([...edges.values()].flatMap((e) => [e.source, e.target]));
    for (const [id, n] of nodes) {
      if (n.kind === 'boundary' && !used.has(id)) nodes.delete(id);
      else if (n.group && !nodes.has(n.group)) nodes.set(id, { ...n, group: null });
    }
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

// What an arrow means, in words: "imports" (static, needed at runtime), "lazy" (dynamic import()),
// "type-only" (erased at compile time), or the Nest relation. Aggregated arrows count each relation.
const RELATION_ORDER = ['imports', 'lazy', 'type-only', 'package-dependency'];
const NEST_RELATION = { 'nest-imports': 'imports', 'nest-injects': 'injects' };
// `imports x152 (test x148)`: the bracket says how many of them come from test files.
const relationText = (rel, tests = {}) => RELATION_ORDER.filter((r) => rel[r])
  .map((r) => `${r}${rel[r] > 1 ? ` x${rel[r]}` : ''}${tests[r] ? ` (test x${tests[r]})` : ''}`).join(', ');
function edgeLabel(e) {
  if (NEST_RELATION[e.kind]) return `${NEST_RELATION[e.kind]}${e.count > 1 ? ` x${e.count}` : ''}`;
  if (e.kind === 'depends-on') {
    const declared = (e.declared ?? []).map((d) => [d.title, d.technology ? `(${d.technology})` : ''].filter(Boolean).join(' ')).join(', ');
    const runtime = Object.entries(e.runtime ?? {}).sort().map(([r, n]) => `${r}${n > 1 ? ` x${n}` : ''} (static pattern)`).join(', ');
    return [declared, relationText(e.relations, e.testRelations), runtime, LINK_STATE_TEXT[e.state]].filter(Boolean).join(' · ');
  }
  return relationText(e.relations ?? { imports: e.count ?? 1 }, e.testRelations);
}
// Dashed when nothing behind the arrow survives compilation (only type-only imports).
// Dashed when only a static call-site pattern backs the arrow, and no model vouches for it.
const patternOnlyEdge = (e) => e.runtime && !Object.keys(e.relations ?? {}).length && !e.state;
const typeOnlyEdge = (e) => e.kind === 'imports' && e.relations && Object.keys(e.relations).every((r) => r === 'type-only');

const q = (s) => String(s).replace(/"/g, '#quot;');

// Explicit fills, strokes and text colour: GitHub renders Mermaid with the reader's theme, and the default dark
// theme draws dark-grey edges on a near-black page. These pairs read on both themes.
const KIND_CLASS = (kind) => (kind === 'external-package' || kind === 'system' ? 'external' : kind === 'container' ? 'container' : kind === 'nest-module' ? 'module' : 'code');
const CLASS_DEFS = [
  '  classDef code fill:#ddf4ff,stroke:#0969da,color:#1f2328',
  '  classDef external fill:#fff8c5,stroke:#9a6700,color:#1f2328',
  '  classDef module fill:#fbefff,stroke:#8250df,color:#1f2328',
  '  classDef added fill:#dafbe1,stroke:#2da44e,stroke-width:2px,color:#1f2328',
  '  classDef removed fill:#ffebe9,stroke:#cf222e,stroke-dasharray:4 3,color:#1f2328',
  '  classDef boundary fill:#f6f8fa,stroke:#57606a,stroke-dasharray:6 4,color:#1f2328',
  '  classDef container fill:#ddf4ff,stroke:#0969da,stroke-width:2px,color:#1f2328',
  '  classDef unverified fill:#ffffff,stroke:#0969da,stroke-width:2px,stroke-dasharray:5 3,color:#1f2328',
  '  classDef undeclared fill:#fff1e5,stroke:#bc4c00,stroke-width:2px,color:#1f2328',
  '  classDef focus fill:#ddf4ff,stroke:#0969da,stroke-width:4px,color:#1f2328',
];
const STATE_CLASS = { 'declared-unverified': 'unverified', undeclared: 'undeclared' };
const nodeClass = (n) => (n.status === 'added' || n.status === 'removed' ? n.status : n.focus ? 'focus' : n.kind === 'boundary' ? 'boundary' : STATE_CLASS[n.state] ?? KIND_CLASS(n.kind));

export function toMermaid(p, { title } = {}) {
  const ids = new Map(p.nodes.map((n, i) => [n.id, `n${i}`]));
  const L = ['flowchart LR'];
  if (title) L.unshift('---', `title: "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, '---');
  const groups = new Map();
  for (const n of p.nodes) { const g = n.group ?? ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); }
  const emit = (n, indent) => {
    const shape = n.kind === 'nest-module' ? `[["${q(n.label)}"]]` : n.kind === 'external-package' || n.kind === 'system' ? `(["${q(n.label)}"])` : `["${q(n.label)}"]`;
    L.push(`${indent}${ids.get(n.id)}${shape}:::${nodeClass(n)}`);
  };
  // A node that owns members (a Nest module) is drawn AS the subgraph, so edges can target it directly.
  const nodeById = new Map(p.nodes.map((n) => [n.id, n]));
  let gi = 0;
  for (const n of groups.get('') ?? []) if (!groups.has(n.id)) emit(n, '  ');
  for (const [g, ns] of [...groups.entries()].sort(byKey(([g]) => g))) {
    if (!g) continue;
    const owner = nodeById.get(g);
    const gid = ids.get(g) ?? `g${gi++}`;
    L.push(`  subgraph ${gid}["${q(owner?.label ?? g.split(':').pop())}"]`);
    ns.forEach((n) => emit(n, '    '));
    L.push('  end');
    if (!owner) L.push(`  style ${gid} fill:#f6f8fa,stroke:#57606a,color:#1f2328`);
    // Subgraphs ignore `class` in Mermaid: copy the class body into a `style` line.
    if (owner) L.push(`  style ${ids.get(g)} ${CLASS_DEFS.find((d) => d.startsWith(`  classDef ${nodeClass(owner)} `)).split(' ').pop()}`);
  }
  const linkStyles = p.edges.length ? ['  linkStyle default stroke:#8c959f,stroke-width:1.5px'] : [];
  p.edges.forEach((e, i) => {
    const label = edgeLabel(e);
    const arrow = e.kind === 'nest-imports' || e.status === 'removed' || e.state === 'declared-unverified' || typeOnlyEdge(e) || patternOnlyEdge(e) ? '-.->' : '-->';
    L.push(`  ${ids.get(e.source)} ${arrow}${label ? `|"${q(label)}"|` : ''} ${ids.get(e.target)}`);
    if (e.status === 'added') linkStyles.push(`  linkStyle ${i} stroke:#2da44e,stroke-width:3px`);
    if (e.status === 'removed') linkStyles.push(`  linkStyle ${i} stroke:#cf222e,stroke-width:2px`);
  });
  L.push(...linkStyles);
  L.push(...CLASS_DEFS);
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
    for (const n of ns) L.push(`${ind}${dq(n.id)} [label=${dq(n.label).replaceAll('<br/>', '\\n')}${n.kind === 'external-package' || n.kind === 'system' ? ', shape=ellipse' : n.kind === 'nest-module' ? ', shape=component' : ''}${n.kind === 'boundary' || n.state === 'declared-unverified' ? ', style=dashed, color="#57606a"' : n.focus ? ', penwidth=4' : ''}${color(n.status)}];`);
    if (g) L.push('  }');
  }
  for (const e of p.edges) {
    const style = e.kind === 'nest-imports' ? 'style=dotted, ' : typeOnlyEdge(e) || patternOnlyEdge(e) || e.state === 'declared-unverified' ? 'style=dashed, ' : '';
    L.push(`  ${dq(e.source)} -> ${dq(e.target)} [${style}label=${dq(edgeLabel(e))}${color(e.status)}];`);
  }
  L.push('}');
  return `${L.join('\n')}\n`;
}

// ---- Diagram assembly: scope, budget, focus, titles, markdown ----

const usage = (message) => Object.assign(new Error(message), { code: 'USAGE' });
const VIEW_NAME = { components: 'Components', files: 'Files', nest: 'Nest DI', containers: 'Containers' };
const CONCERN = {
  components: 'Which folders depend on which, and how?',
  files: 'Which files import which?',
  containers: 'Which units run or ship, and how do they depend on each other?',
  nest: 'Which Nest modules import each other, and which classes are injected where?',
};

// Keep one element and the arrows that touch it, plus the elements at their other end.
function focusProjection(p, id) {
  let hits = p.nodes.filter((n) => n.id === id);
  if (!hits.length) hits = p.nodes.filter((n) => n.label === id || n.id === `dir:${id}`);
  if (!hits.length) throw usage(`--focus: no element "${id}" in this view; use a node id, a file path or a component folder shown by the full diagram`);
  if (hits.length > 1) throw usage(`--focus: "${id}" is ambiguous (${hits.map((n) => n.id).join(', ')}); use the full id`);
  const hit = hits[0];
  const edges = p.edges.filter((e) => e.source === hit.id || e.target === hit.id);
  const keep = new Set([hit.id, ...edges.flatMap((e) => [e.source, e.target])]);
  const nodes = p.nodes.filter((n) => keep.has(n.id)).map((n) => ({ ...n, ...(n.group && !keep.has(n.group) ? { group: null } : {}), ...(n.id === hit.id ? { focus: true } : {}) }));
  return { nodes, edges, focusLabel: hit.label };
}

const over = (p, { maxNodes, maxEdges }) => (maxNodes > 0 && p.nodes.length > maxNodes) || (maxEdges > 0 && p.edges.length > maxEdges);
function overParts(p, { maxNodes, maxEdges }, fmt) {
  const out = [];
  if (maxNodes > 0 && p.nodes.length > maxNodes) out.push(fmt('boxes', p.nodes.length, maxNodes));
  if (maxEdges > 0 && p.edges.length > maxEdges) out.push(fmt('arrows', p.edges.length, maxEdges));
  return out.join(' and ');
}

// Builds everything a renderer needs: the (possibly reduced) projection, its title, concern and scope notes.
export function buildDiagram(snapshot, { view = 'components', depth = 2, externals = false, within = null, focus = null, maxNodes = 40, maxEdges = 100, before = null, noTests = false } = {}) {
  let hiddenTests = 0;
  if (noTests) {
    ({ snapshot, hidden: hiddenTests } = withoutTests(snapshot));
    if (before) before = withoutTests(before).snapshot;
  }
  if (within !== null) {
    within = within.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (!within || within === '.') throw usage('--within needs a folder below the repository root, e.g. --within src/users');
  }
  const budget = { maxNodes, maxEdges };
  const wDepth = within ? within.split('/').length : 0;
  const make = (d, scope) => {
    const o = { view, depth: d, externals, within: scope ? within : null };
    const a = project(snapshot, o);
    return before ? compareProjections(project(before, o), a) : a;
  };
  const notes = [];
  let d = depth, p = make(d, true);
  let fullAt = within ? make(d + wDepth, false) : p;
  let focusLabel = null;
  if (focus !== null) ({ focusLabel, ...p } = focusProjection(p, focus));
  if (view === 'components' && focus === null) {
    const first = p;
    while (over(p, budget) && d > 1) { d--; p = make(d, true); }
    if (d < depth) {
      notes.push(`depth reduced from ${depth} to ${d} to fit ${overParts(first, budget, (w, _n, max) => `${max} ${w}`)}`);
      fullAt = within ? make(d + wDepth, false) : p;
    }
    if (over(p, budget)) notes.push(`${d < depth ? 'still exceeds' : 'exceeds'} the budget: ${overParts(p, budget, (w, n, max) => `${n} ${w} (max ${max})`)}`);
  } else if (over(p, budget)) {
    throw usage(`${VIEW_NAME[view]} view has ${p.nodes.length} nodes and ${p.edges.length} edges, over the budget of ${maxNodes || 'unlimited'} nodes and ${maxEdges || 'unlimited'} edges (--max-nodes, --max-edges). Narrow it with --within <dir>, --focus <id> or --view components; --max-nodes 0 disables the node budget.`);
  }
  const subject = `${snapshot.subject.name}${snapshot.subject.commit ? `@${snapshot.subject.commit.slice(0, 10)}` : ''}`;
  const quals = [...(view === 'components' ? [`depth ${d}`] : []), ...(within ? [`within ${within}`] : []), ...(before ? ['compared'] : [])];
  const base = `${VIEW_NAME[view]} of ${subject}${quals.length ? ` (${quals.join(', ')})` : ''}`;
  const unit = view === 'components' ? 'folders' : view === 'files' ? (externals ? 'files and packages' : 'files') : view === 'containers' ? 'containers and systems' : 'Nest nodes';
  const shown = p.nodes.filter((n) => n.kind !== 'boundary').length, boundaries = p.nodes.length - shown;
  const scope = [`Snapshot ${subject}`, `showing ${shown} of ${fullAt.nodes.filter((n) => n.kind !== 'boundary').length} ${unit}`];
  if (within) scope.push(`within ${within}${boundaries ? ` (outside neighbours collapsed into ${boundaries} boundary ${boundaries === 1 ? 'box' : 'boxes'})` : ''}`);
  if (focus !== null) scope.push(`focus on ${focusLabel} (direct dependencies and dependents only)`);
  if (noTests) scope.push(`test imports hidden (--no-tests): ${hiddenTests}`);
  scope.push(...notes);
  return {
    projection: p, view, title: focus !== null ? `Focus on ${focusLabel} in ${base}` : base,
    concern: focus !== null ? `What does ${focusLabel} use, and what uses ${focusLabel}?` : CONCERN[view],
    scope: scope.join(' · '),
  };
}

// One row per style actually present in the projection: [mark, meaning].
function containerLegend(p) {
  const rows = [], has = (f) => p.nodes.some(f), edge = (f) => p.edges.some(f);
  if (has((n) => n.kind === 'container' && !n.state)) rows.push(['Blue box', 'Container: a unit that runs or ships, with its path and technology']);
  if (has((n) => n.state === 'declared-unverified')) rows.push(['Dashed blue box', 'Declared in the model, no manifest proves it (`declared, unverified`)']);
  if (has((n) => n.state === 'undeclared')) rows.push(['Orange box', 'Found in the code, not declared in the model (`in code, not in model`)']);
  if (has((n) => n.kind === 'system')) rows.push(['Yellow rounded box', 'System outside the repository, declared in the model']);
  if (has((n) => n.group)) rows.push(['Labelled frame', 'The system the model declares these containers in']);
  if (edge((e) => e.declared)) rows.push(['Words before the first `·`', 'Relation declared in the model, with its technology in brackets']);
  const rel = new Set(p.edges.flatMap((e) => Object.keys(e.relations ?? {})));
  if (rel.has('imports') || rel.has('lazy') || rel.has('type-only')) rows.push(['`imports`, `lazy`, `type-only`', 'Code imports that cross from one container into the other, counted']);
  if (edge((e) => e.testRelations)) rows.push(['`(test x2)` after a count', 'How many of those imports come from test files (test globs recorded in the snapshot)']);
  if (rel.has('package-dependency')) rows.push(['`package-dependency`', 'A package.json dependency on the other container']);
  if (edge((e) => e.state === 'declared-unverified')) rows.push(['Dashed arrow ending in `unverified`', 'Declared in the model, no static evidence in the code (runtime links such as HTTP or IPC are never visible statically)']);
  if (edge((e) => e.state === 'code-dependency-only')) rows.push(['Arrow ending in `code only, runtime unverified`', 'Declared as a runtime link (HTTP, IPC, child process, queue...); the code shows imports between the two containers, but nothing proves the runtime link itself']);
  const runtime = new Set(p.edges.flatMap((e) => Object.keys(e.runtime ?? {})));
  const RUNTIME_ROWS = {
    'child-process': 'A call site starts the other container as a child process (literal program or bin name)',
    sidecar: 'A Tauri sidecar call names a binary the other container builds',
    'http-route': 'A client call\'s literal path matches a route only the other container defines',
    amqp: 'This container publishes a routing key or queue (RabbitMQ) that the other container binds or consumes; the arrow points from producer to consumer',
    bullmq: 'This container adds jobs to a BullMQ queue that the other container processes; the arrow points from producer to consumer',
  };
  for (const r of Object.keys(RUNTIME_ROWS)) if (runtime.has(r)) rows.push([`\`${r} (static pattern)\``, `${RUNTIME_ROWS[r]}; read by a line pattern, lower confidence than an import, dashed when nothing else backs the arrow`]);
  if (edge((e) => e.state === 'evidenced')) rows.push(['Arrow ending in `evidenced (static pattern)`', 'Declared as a runtime link (child process, sidecar, HTTP, queue) in the model, and a call site of that kind matches it']);
  if (edge((e) => e.state === 'undeclared')) rows.push(['Arrow ending in `not in model`', 'Found in the code, not declared in the model']);
  return rows;
}

function legendRows(p, view) {
  if (view === 'containers') return containerLegend(p);
  const rel = new Set();
  let counted = false;
  for (const e of p.edges) {
    if (NEST_RELATION[e.kind]) rel.add(e.kind);
    else for (const r of Object.keys(e.relations ?? { imports: 1 })) rel.add(r);
    if (e.count > 1) counted = true;
  }
  const kinds = new Set(p.nodes.filter((n) => !n.status && !n.focus && n.kind !== 'boundary').map((n) => KIND_CLASS(n.kind)));
  const has = (f) => p.nodes.some(f);
  const rows = [];
  if (kinds.has('code')) rows.push(['Blue box', view === 'components' ? 'Folder (a component of the code)' : view === 'files' ? 'Source file' : 'Nest provider, controller or injectable']);
  if (kinds.has('external')) rows.push(['Yellow rounded box', 'External npm package']);
  if (kinds.has('module')) rows.push(['Purple double-bordered box', 'Nest module; the boxes inside it are its providers']);
  if (has((n) => n.kind === 'boundary')) rows.push(['Dashed grey box', 'Outside the zoomed scope, collapsed per top-level folder or package']);
  if (has((n) => n.focus)) rows.push(['Thick-bordered box', 'The focused element']);
  if (has((n) => n.status === 'added')) rows.push(['Green box with thick border', 'Added since the compared snapshot']);
  if (has((n) => n.status === 'removed')) rows.push(['Red dashed box', 'Removed since the compared snapshot']);
  if (rel.has('imports')) rows.push(['Solid arrow labelled `imports`', 'Static import, needed at runtime (arrow points at the imported element)']);
  if (rel.has('lazy')) rows.push(['Solid arrow labelled `lazy`', 'Dynamic import(), loaded on demand']);
  if (rel.has('type-only')) rows.push(['Dashed arrow labelled `type-only`', 'Import erased at compile time (the arrow is dashed when only type-only imports back it)']);
  if (rel.has('nest-imports')) rows.push(['Dashed arrow labelled `imports`', 'A Nest module imports another module']);
  if (rel.has('nest-injects')) rows.push(['Solid arrow labelled `injects`', 'A class is injected into another']);
  if (counted) rows.push(['`x3` after a label', 'How many underlying relations the arrow stands for']);
  if (p.edges.some((e) => e.testRelations)) rows.push(['`(test x2)` after a count', 'How many of those relations come from test files (test globs recorded in the snapshot)']);
  if (p.edges.some((e) => e.status === 'added')) rows.push(['Thick green arrow', 'Added since the compared snapshot']);
  if (p.edges.some((e) => e.status === 'removed')) rows.push(['Red dashed arrow', 'Removed since the compared snapshot']);
  return rows;
}

// Container facts as a table: what a maintainer of each container has to know and carry.
const factsCells = (f) => {
  const langs = Object.entries(f.languages).sort(([a, x], [b, y]) => y.lines - x.lines || (a < b ? -1 : 1)).slice(0, 5).map(([l, x]) => `${l} ${x.lines}`).join(', ');
  const counts = (m) => [m.dependencies !== undefined && `${m.dependencies} dep${m.dependencies === 1 ? "" : "s"}`, m.devDependencies && `${m.devDependencies} dev`, m.indirect && `${m.indirect} indirect`].filter(Boolean).join(', ');
  const name = (m) => m.file.split('/').pop();
  const manifests = [...f.manifests.filter((m) => m.kind !== 'lockfile').map((m) => (counts(m) ? `${name(m)} (${counts(m)})` : name(m))), ...f.manifests.filter((m) => m.kind === 'lockfile').map(name)].join(', ');
  return [f.files, f.lines, langs || '-', manifests || '-', f.toolchains.map((t) => t.name).join(', ') || '-'];
};
function factsTable(p) {
  const rows = p.nodes.filter((n) => n.facts).sort(byKey((n) => n.path)).map((n) => `| ${n.path} | ${factsCells(n.facts).join(' | ')} |`);
  return rows.length ? ['**Container facts**', '', 'Counted from the files in each container (lockfiles left out of files and lines); facts, not a score.', '',
    '| Container | Files | Lines | Languages (lines) | Manifests | Toolchains |', '| --- | ---: | ---: | --- | --- | --- |', ...rows, ''] : [];
}

export function toMarkdownView(d) {
  const rows = legendRows(d.projection, d.view).map(([m, t]) => `| ${m} | ${t} |`);
  return [`## ${d.title}`, '', d.concern, '', d.scope, '', '```mermaid', toMermaid(d.projection, { title: d.title }).trimEnd(), '```', '',
    '**Legend**', '', '| Mark | Meaning |', '| --- | --- |', ...rows, '', ...(d.view === 'containers' ? factsTable(d.projection) : [])].join('\n');
}
