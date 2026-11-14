// Test or production: a code node is a test when its path matches one of the test globs. The mark
// is a path convention, not proof that the file is a test; the globs are recorded in `analyses`.

export const DEFAULT_TEST_GLOBS = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*'];

// Glob subset: `**` (any number of folders), `*` (within one segment), `?` (one character).
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '/' && glob.slice(i + 1) === '**') { re += '(?:/.*)?'; break; }
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function testMatcher(globs = DEFAULT_TEST_GLOBS) {
  const res = globs.map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}

const CODE_KINDS = new Set(['file', 'go-package']);
const pathOf = (n) => (n.kind === 'file' ? n.id : n.file);

// Marks code nodes in place; returns how many were marked.
export function markTests(nodes, globs = DEFAULT_TEST_GLOBS) {
  const isTest = testMatcher(globs);
  let count = 0;
  for (const n of nodes) {
    if (CODE_KINDS.has(n.kind) && pathOf(n) !== undefined && isTest(pathOf(n))) { n.test = true; count++; }
  }
  return count;
}

// The production view of a snapshot: imports from test files are dropped, test nodes left without
// any edge are dropped, depends-on links lose their test share (and disappear when nothing else,
// declared or observed, backs them). Returns the filtered copy and how many imports were hidden.
export function withoutTests(snapshot) {
  const tests = new Set(snapshot.nodes.filter((n) => n.test).map((n) => n.id));
  let hidden = 0;
  const edges = [];
  for (const e of snapshot.edges) {
    if (e.kind === 'imports' && tests.has(e.source)) { hidden++; continue; }
    if (e.kind === 'depends-on' && e.testRelations) {
      const relations = {};
      for (const [r, n] of Object.entries(e.relations ?? {})) if (n - (e.testRelations[r] ?? 0) > 0) relations[r] = n - (e.testRelations[r] ?? 0);
      const { testRelations: _, ...rest } = e;
      if (Object.keys(relations).length || e.declared) edges.push({ ...rest, relations });
      continue;
    }
    edges.push(e);
  }
  const used = new Set(edges.flatMap((e) => [e.source, e.target]));
  const nodes = snapshot.nodes.filter((n) => !tests.has(n.id) || used.has(n.id));
  const kept = new Set(nodes.map((n) => n.id));
  const findings = snapshot.findings.filter((f) => !f.subjects.every((s) => tests.has(s) && !kept.has(s)));
  return { snapshot: { ...snapshot, nodes, edges, findings }, hidden };
}
