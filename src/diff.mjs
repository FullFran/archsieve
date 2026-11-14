import { edgeKey } from './util.mjs';
import { SCHEMA_VERSION } from './scan.mjs';
import { project } from './render.mjs';
import { withoutTests } from './tests.mjs';

const LEVELS = ['error', 'signal', 'unknown'];

function setDiff(before, after, key) {
  const b = new Map(before.map((x) => [key(x), x])), a = new Map(after.map((x) => [key(x), x]));
  return { added: after.filter((x) => !b.has(key(x))), removed: before.filter((x) => !a.has(key(x))) };
}

const countBy = (xs, f) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});

export function diff(before, after, { depth = 2, noTests = false } = {}) {
  const warnings = [];
  if (noTests) {
    before = withoutTests(before).snapshot;
    after = withoutTests(after).snapshot;
    warnings.push('Imports from test files were left out (--no-tests); test globs are recorded in each snapshot\'s analyses.');
  }
  const nodes = setDiff(before.nodes, after.nodes, (n) => n.id);
  const edges = setDiff(before.edges, after.edges, edgeKey);
  const f = setDiff(before.findings, after.findings, (x) => x.id);
  const tv = (s) => JSON.stringify(s.tools);
  if (tv(before) !== tv(after)) warnings.push('Tool sets or versions differ between snapshots; some changes may come from the tools, not the code.');
  if (after.subject.dirty) warnings.push('The "after" snapshot was taken from a working tree with uncommitted changes.');
  const kinds = [...new Set([...before.nodes, ...after.nodes].map((n) => n.kind))].sort();
  const ekinds = [...new Set([...before.edges, ...after.edges].map((e) => e.kind))].sort();
  const nb = countBy(before.nodes, (n) => n.kind), na = countBy(after.nodes, (n) => n.kind);
  const eb = countBy(before.edges, (e) => e.kind), ea = countBy(after.edges, (e) => e.kind);
  // Component level: the same projection the diagrams use (directories at `depth`).
  const pb = project(before, { view: 'components', depth }), pa = project(after, { view: 'components', depth });
  const cn = setDiff(pb.nodes, pa.nodes, (n) => n.id);
  const ce = setDiff(pb.edges, pa.edges, (e) => `${e.source}\u0000${e.target}`);
  const dep = (e) => {
    const tests = Object.values(e.testRelations ?? {}).reduce((a, b) => a + b, 0);
    return { from: e.source.slice(4), to: e.target.slice(4), fileEdges: e.count, ...(tests ? { testEdges: tests } : {}) };
  };
  const components = {
    depth,
    added: cn.added.map((n) => n.label), removed: cn.removed.map((n) => n.label),
    dependencies: { added: ce.added.map(dep), removed: ce.removed.map(dep) },
  };
  // Container facts that changed, for containers present with facts on both sides.
  const factsOf = (snap) => new Map(snap.nodes.filter((n) => n.kind === 'container' && n.facts).map((n) => [n.id, n.facts]));
  const fb = factsOf(before), fa = factsOf(after);
  const deps = (f) => f.manifests.reduce((s, m) => s + (m.dependencies ?? 0) + (m.devDependencies ?? 0), 0);
  const containerFacts = [];
  for (const [id, a] of [...fa].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const b = fb.get(id);
    if (!b) continue;
    const tb = new Set(b.toolchains.map((t) => t.name)), ta = new Set(a.toolchains.map((t) => t.name));
    const c = {
      id, files: { before: b.files, after: a.files }, lines: { before: b.lines, after: a.lines }, dependencies: { before: deps(b), after: deps(a) },
      toolchains: { added: [...ta].filter((t) => !tb.has(t)).sort(), removed: [...tb].filter((t) => !ta.has(t)).sort() },
    };
    if (c.files.before !== c.files.after || c.lines.before !== c.lines.after || c.dependencies.before !== c.dependencies.after || c.toolchains.added.length || c.toolchains.removed.length) containerFacts.push(c);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'archsieve-diff',
    before: before.subject,
    after: after.subject,
    warnings,
    summary: {
      nodes: Object.fromEntries(kinds.map((k) => [k, { before: nb[k] ?? 0, after: na[k] ?? 0 }])),
      edges: Object.fromEntries(ekinds.map((k) => [k, { before: eb[k] ?? 0, after: ea[k] ?? 0 }])),
      newFindings: Object.fromEntries(LEVELS.map((l) => [l, f.added.filter((x) => x.level === l).length])),
      resolvedFindings: Object.fromEntries(LEVELS.map((l) => [l, f.removed.filter((x) => x.level === l).length])),
    },
    components,
    nodes: nodes,
    edges: edges,
    findings: { new: f.added, resolved: f.removed },
    ...(fb.size && fa.size ? { containerFacts } : {}),
  };
}

export function toMarkdown(d) {
  const L = [];
  const sha = (s) => (s.commit ? s.commit.slice(0, 10) : 'no-commit') + (s.dirty ? '+dirty' : '');
  L.push(`# ArchSieve diff: ${d.before.name}@${sha(d.before)} -> ${d.after.name}@${sha(d.after)}`, '');
  for (const w of d.warnings) L.push(`> Warning: ${w}`);
  if (d.warnings.length) L.push('');
  L.push('## Structure (observed counts)', '', '| kind | before | after | delta |', '|---|---:|---:|---:|');
  for (const [k, v] of [...Object.entries(d.summary.nodes), ...Object.entries(d.summary.edges).map(([k, v]) => [`edge:${k}`, v])]) {
    const delta = v.after - v.before;
    L.push(`| ${k} | ${v.before} | ${v.after} | ${delta > 0 ? '+' : ''}${delta} |`);
  }
  const sec = (title, level, list) => {
    const xs = list.filter((x) => x.level === level);
    if (!xs.length) return;
    L.push('', `### ${title} (${xs.length})`, '');
    for (const x of xs) L.push(`- \`${x.rule}\` ${x.message}`);
  };
  const c = d.components;
  L.push('', `## Component dependencies (directories at depth ${c.depth})`, '');
  if (!c.added.length && !c.removed.length && !c.dependencies.added.length && !c.dependencies.removed.length) L.push('No component-level change.');
  for (const x of c.added) L.push(`- new component \`${x}\``);
  for (const x of c.removed) L.push(`- removed component \`${x}\``);
  for (const x of c.dependencies.added) L.push(`- NEW dependency \`${x.from}\` -> \`${x.to}\` (${x.fileEdges} file import(s)${x.testEdges ? `, ${x.testEdges} from tests` : ''})`);
  for (const x of c.dependencies.removed) L.push(`- removed dependency \`${x.from}\` -> \`${x.to}\``);
  if (d.containerFacts?.length) {
    const cell = (v) => (v.before === v.after ? `${v.after}` : `${v.after} (${v.after > v.before ? '+' : ''}${v.after - v.before})`);
    L.push('', '## Container facts', '', '| Container | Files | Lines | Dependencies | Toolchains |', '|---|---:|---:|---:|---|');
    for (const c of d.containerFacts) {
      const tc = [c.toolchains.added.length && `added: ${c.toolchains.added.join(', ')}`, c.toolchains.removed.length && `removed: ${c.toolchains.removed.join(', ')}`].filter(Boolean).join('; ') || 'no change';
      L.push(`| ${c.id.replace(/^container:/, '')} | ${cell(c.files)} | ${cell(c.lines)} | ${cell(c.dependencies)} | ${tc} |`);
    }
  }
  L.push('', '## New findings');
  sec('Errors: verifiable regressions', 'error', d.findings.new);
  sec('Signals: heuristics, need human/agent judgement', 'signal', d.findings.new);
  sec('Unknowns: not inferable from static evidence', 'unknown', d.findings.new);
  if (!d.findings.new.length) L.push('', 'None.');
  if (d.findings.resolved.length) {
    L.push('', '## Resolved findings', '');
    for (const x of d.findings.resolved) L.push(`- [${x.level}] \`${x.rule}\` ${x.message}`);
  }
  const list = (title, xs, fmt) => {
    if (!xs.length) return;
    L.push('', `## ${title} (${xs.length})`, '');
    for (const x of xs.slice(0, 200)) L.push(`- ${fmt(x)}`);
    if (xs.length > 200) L.push(`- ... ${xs.length - 200} more (see JSON)`);
  };
  list('Added nodes', d.nodes.added, (n) => `\`${n.id}\` (${n.kind})`);
  list('Removed nodes', d.nodes.removed, (n) => `\`${n.id}\` (${n.kind})`);
  list('Added edges', d.edges.added, (e) => `\`${e.source}\` -> \`${e.target}\` (${e.kind}${e.typeOnly ? ', type-only' : ''})`);
  list('Removed edges', d.edges.removed, (e) => `\`${e.source}\` -> \`${e.target}\` (${e.kind})`);
  L.push('', '_Facts come from the listed tools for these exact commits. Signals are not defects. Unknowns are not absences._', '');
  return L.join('\n');
}
