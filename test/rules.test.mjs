import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { cli, scratch, fixture, readJson } from './helpers.mjs';

const errors = (snap) => snap.findings.filter((f) => f.level === 'error');

function scanLayers(t, rulesFile) {
  const out = join(scratch(t), 's.json');
  const r = cli(['scan', fixture('layers'), '--no-units', '-o', out, ...(rulesFile ? ['--rules', fixture('layers', rulesFile)] : [])]);
  return { r, out, snap: r.code === 0 ? readJson(out) : null };
}

test('forbidden rules: dependencies only go down across four folders; each broken rule is an error finding with the edge evidence (#28)', (t) => {
  const { r, out, snap } = scanLayers(t, 'down-only.rules.json');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /findings: 1 error,/);
  assert.deepEqual(errors(snap).map(({ id, rule, subjects, evidence }) => ({ id, rule, subjects, evidence })), [{
    id: 'a-is-the-bottom:src/a/uses-d.ts|src/d/top.ts',
    rule: 'a-is-the-bottom',
    subjects: ['src/a/uses-d.ts', 'src/d/top.ts'],
    evidence: [{ tool: 'dependency-cruiser', file: 'src/a/uses-d.ts', detail: '../d/top' }, { tool: 'archsieve rules', file: fixture('layers', 'down-only.rules.json'), detail: 'forbidden[0]' }],
  }]);
  assert.match(errors(snap)[0].message, /a-is-the-bottom: src\/a\/uses-d\.ts -> src\/d\/top\.ts \(a depends on no other layer\.\)/);
  // d -> a, d -> c, c -> b, c -> a and b -> a go down: none is a finding.
  assert.ok(snap.edges.some((e) => e.source === 'src/d/d.ts' && e.target === 'src/a/a.ts'));
  assert.ok(snap.analyses.some((a) => a.tool === 'declared rules' && a.status === 'ok' && /3 forbidden, 0 allowed; 1 violation/.test(a.note)));
  assert.equal(cli(['validate', out]).code, 0);

  // The existing gate works unchanged: a rule broken after, not before, is a new error.
  const before = scanLayers(t);
  assert.equal(before.r.code, 0, before.r.stderr);
  assert.deepEqual(errors(before.snap), []);
  const gate = cli(['diff', before.out, out, '--fail-on', 'error']);
  assert.equal(gate.code, 1, gate.stderr);
  assert.match(gate.stderr, /new findings: 1 error/);
  assert.equal(cli(['diff', out, out, '--fail-on', 'error']).code, 0, 'a rule already broken in the baseline is not new');
});

test('allowed rules: an edge that matches no allowed rule is a not-in-allowed error; $1 reuses the from groups (#28)', (t) => {
  const { r, snap } = scanLayers(t, 'down-only.allowed.rules.json');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(errors(snap).map((f) => [f.rule, f.subjects, f.evidence[0].detail]), [['not-in-allowed', ['src/a/uses-d.ts', 'src/d/top.ts'], '../d/top']]);
});

test('rules match node ids, so they work for Go packages too (#28)', (t) => {
  const dir = scratch(t);
  const rules = join(dir, 'go.rules.json');
  writeFileSync(rules, JSON.stringify({ forbidden: [{ name: 'a-not-to-b', from: { path: '^go:.*/internal/a$' }, to: { path: '/internal/b$' } }] }));
  const out = join(dir, 's.json');
  const r = cli(['scan', fixture('go-mini'), '--no-js', '--go', '.', '--rules', rules, '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(errors(readJson(out)).map((f) => [f.rule, f.subjects, f.evidence[0].tool]),
    [['a-not-to-b', ['go:example.com/gomini/internal/a', 'go:example.com/gomini/internal/b'], 'go list']]);
});

test('a malformed rules file is a usage error with exit 2, never a silent pass; validate checks rules files (#28)', (t) => {
  const dir = scratch(t);
  const cases = {
    'not-json.json': ['{ "forbidden": [', /not valid JSON/],
    'no-to.json': [JSON.stringify({ forbidden: [{ name: 'x', from: { path: '^src/' } }] }), /forbidden\/0 must have required property 'to'/],
    'bad-regex.json': [JSON.stringify({ forbidden: [{ name: 'x', from: { path: '^src/(' }, to: {} }] }), /forbidden\[0\]\.from\.path is not a valid regular expression/],
    'duplicate.json': [JSON.stringify({ forbidden: [{ name: 'x', from: {}, to: { path: 'a' } }, { name: 'x', from: {}, to: { path: 'b' } }] }), /duplicate rule name "x"/],
    'empty.json': [JSON.stringify({}), /must have at least one forbidden or allowed rule|must have required property/],
  };
  for (const [name, [body, message]] of Object.entries(cases)) {
    const file = join(dir, name);
    writeFileSync(file, body);
    const out = join(dir, `${name}.out.json`);
    const r = cli(['scan', fixture('layers'), '--no-units', '--rules', file, '-o', out]);
    assert.equal(r.code, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /\[BAD_RULES\]/, name);
    assert.match(r.stderr, message, name);
    assert.ok(!existsSync(out), `${name}: no snapshot is written`);
  }
  assert.equal(cli(['scan', fixture('layers'), '--rules', join(dir, 'missing.json')]).code, 2);
  const ok = cli(['validate', fixture('layers', 'down-only.rules.json')]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(cli(['validate', fixture('layers', 'down-only.allowed.rules.json')]).code, 0);
  const bad = cli(['validate', join(dir, 'no-to.json')]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /must have required property 'to'/);
});
