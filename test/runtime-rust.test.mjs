import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

// fixtures/runtime-rust: a Tauri shell (shell/src-tauri) runs the bin 'helper' through a const with
// Command::new, runs 'ls' (outside the repository), starts the sidecar 'engine' declared in
// bundle.externalBin (a Go module whose binary is named after its module path), and runs a program
// read from the environment.
function scanRust(t) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', fixture('runtime-rust'), '--go', 'none', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return readJson(out);
}

test('S6 scan: Rust Command::new and Tauri sidecars become runtime links with file:line', (t) => {
  const snap = scanRust(t);
  const links = snap.edges.filter((e) => e.kind === 'runtime-link').map((e) => [e.source, e.target, e.relations, e.evidence.map((x) => `${x.file}:${x.line}`)]);
  assert.deepEqual(links, [
    ['container:shell/src-tauri', 'container:engine', { sidecar: 1 }, ['shell/src-tauri/src/ipc/run.rs:4']],
    ['container:shell/src-tauri', 'container:helper', { 'child-process': 1 }, ['shell/src-tauri/src/main.rs:6']],
  ]);
});

test('S6 scan: a Rust program that is not a literal is unknown; the note counts Rust files read', (t) => {
  const snap = scanRust(t);
  const u = snap.findings.filter((f) => f.rule === 'runtime-call-unresolved');
  assert.deepEqual(u.map((f) => [f.subjects[0], f.evidence.map((e) => e.line)]), [['shell/src-tauri/src/ipc/run.rs', [6]]]);
  assert.match(snap.analyses.find((a) => a.tool === 'archsieve patterns').note, /2 runtime links, 1 call site to programs outside the repository, 1 unresolved; .*2 Rust files/);
});
