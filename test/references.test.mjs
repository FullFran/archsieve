import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

// fixtures/references: a Rust file in the desktop container says it mirrors a Node file of the
// installer container; a Node file says it follows the same rule (same language and container); a
// string literal names a template; a markdown doc names a file; a comment names a missing file; and
// installer/lib/check.mjs names a file it also imports.
function scanRefs(t, extra = []) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', fixture('references'), '--go', 'none', '-o', out, ...extra]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return { file: out, snap: readJson(out) };
}
const refs = (snap) => snap.edges.filter((e) => e.kind === 'references');

test('S10 scan: repository paths named in comments, strings and docs become low-confidence references edges with file:line', (t) => {
  const { snap } = scanRefs(t);
  assert.deepEqual(refs(snap).map((e) => [e.source, e.target, e.confidence, e.evidence.map((x) => `${x.file}:${x.line}`)]), [
    ['desktop/src-tauri/src/paths.rs', 'installer/lib/paths.mjs', 'pattern', ['desktop/src-tauri/src/paths.rs:1']],
    ['docs/layout.md', 'installer/lib/paths.mjs', 'pattern', ['docs/layout.md:3']],
    ['installer/lib/report.mjs', 'installer/templates/report.txt', 'pattern', ['installer/lib/report.mjs:1']],
    ['installer/lib/same.mjs', 'installer/lib/paths.mjs', 'pattern', ['installer/lib/same.mjs:2']],
  ]);
  assert.match(snap.analyses.find((a) => a.tool === 'path references').note, /4 references from \d+ files; 1 already an import, left out/);
});

test('S10 scan: mirror wording across languages or containers is a signal; within one language and container it is not', (t) => {
  const { snap } = scanRefs(t);
  const m = snap.findings.filter((f) => f.rule === 'mirrored-logic');
  assert.deepEqual(m.map((f) => [f.level, ...f.subjects]), [['signal', 'desktop/src-tauri/src/paths.rs', 'installer/lib/paths.mjs']]);
  assert.match(m[0].message, /rust -> javascript/);
  assert.match(m[0].message, /container:desktop\/src-tauri -> container:installer/);
  assert.deepEqual(m[0].evidence, [{ tool: 'archsieve patterns', file: 'desktop/src-tauri/src/paths.rs', line: 1, detail: '// Mirrors installer/lib/paths.mjs: keep the data layout in sync.' }]);
});

test('S10 references stay out of views and of affected', (t) => {
  const { file } = scanRefs(t);
  const d = JSON.parse(cli(['affected', file, '--changed', 'installer/lib/paths.mjs']).stdout);
  assert.deepEqual(d.files, ['installer/lib/check.mjs', 'installer/lib/paths.mjs']);
  const snap = readJson(file);
  const without = join(scratch(t), 'without.json');
  writeFileSync(without, JSON.stringify({ ...snap, edges: snap.edges.filter((e) => e.kind !== 'references') }));
  for (const view of ['components', 'containers', 'files']) assert.equal(cli(['render', file, '--view', view]).stdout, cli(['render', without, '--view', view]).stdout, view);
});
