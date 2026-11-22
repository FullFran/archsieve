import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cli, scratch, fixture, readJson } from './helpers.mjs';
import { topicMatch } from '../src/adapters/queues.mjs';

// fixtures/queues: api (TS, amqplib + BullMQ) and extractor (Python, aio-pika). The API publishes
// doc.extract.requested through a helper method; the extractor binds its queue to it, resolving the
// key through an environment default in another file. The extractor publishes doc.extract.completed
// through a wrapper and kicks jobs.default through the default exchange; the API consumes both.
function scanQueues(t, extra = []) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', fixture('queues'), '--go', 'none', '-o', out, ...extra]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return readJson(out);
}

test('S8 scan: a producer and a consumer that name the same routing key or queue are an amqp runtime link, across languages', (t) => {
  const snap = scanQueues(t);
  const links = snap.edges.filter((e) => e.kind === 'runtime-link').map((e) => [e.source, e.target, e.relations, e.confidence, e.evidence.map((x) => `${x.file}:${x.line}`)]);
  assert.deepEqual(links, [
    ['container:api', 'container:extractor', { amqp: 1 }, 'pattern', ['api/src/publisher.ts:12', 'extractor/src/extractor/worker.py:31']],
    ['container:extractor', 'container:api', { amqp: 2 }, 'pattern', ['api/src/results.ts:8', 'api/src/results.ts:10', 'extractor/src/extractor/worker.py:16', 'extractor/src/extractor/worker.py:22']],
  ]);
});

test('S8 scan: BullMQ pairs inside one container make no edge; an unmatched queue or key is a signal', (t) => {
  const snap = scanQueues(t);
  const f = (rule) => snap.findings.filter((x) => x.rule === rule).map((x) => [x.level, x.subjects[0], x.evidence.map((e) => `${e.file}:${e.line}`)]);
  assert.deepEqual(f('queue-producer-without-consumer'), [
    ['signal', 'amqp:key:doc.extract.failed', ['extractor/src/extractor/worker.py:19']],
    ['signal', 'bullmq:audit.events', ['api/src/reports.ts:6']],
  ]);
  assert.deepEqual(f('queue-consumer-without-producer'), []);
  assert.ok(!snap.edges.some((e) => e.kind === 'runtime-link' && e.relations.bullmq));
});

test('S8 scan: a name that is not a literal, a constant or an env default is an unknown finding with file and line', (t) => {
  const snap = scanQueues(t);
  const u = snap.findings.filter((x) => x.rule === 'queue-name-unresolved').map((x) => [x.level, x.subjects[0], x.evidence.map((e) => e.line)]);
  assert.deepEqual(u, [
    ['unknown', 'api/src/reports.ts', [7]],
    ['unknown', 'api/src/results.ts', [11]],
  ]);
  assert.ok(!snap.findings.some((x) => JSON.stringify(x).includes('test.only.key') || JSON.stringify(x).includes('commented.out')), 'tests and comments are skipped');
});

test('S8 scan --model: a queue link evidences a declared queue link, not a declared HTTP one', (t) => {
  const snap = scanQueues(t, ['--model', fixture('queues', 'architecture', 'model.likec4.json')]);
  const status = (s, d) => snap.edges.find((e) => e.kind === 'depends-on' && e.source === s && e.target === d).status;
  assert.equal(status('container:api', 'container:extractor'), 'evidenced');
  assert.equal(status('container:extractor', 'container:api'), 'declared-unverified');
});

test('S8 render: the container view shows the queue relation as a static pattern, and its legend row', (t) => {
  const out = join(scratch(t), 'snap.json');
  assert.equal(cli(['scan', fixture('queues'), '--go', 'none', '-o', out]).code, 0);
  const r = cli(['render', out, '--view', 'containers', '--format', 'md']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /amqp x2 \(static pattern\)/);
  assert.match(r.stdout, /`amqp \(static pattern\)`/);
});

test('S8 patterns: topic bindings match routing keys word by word', () => {
  const yes = [['a.b.c', 'a.b.c'], ['a.*.c', 'a.x.c'], ['a.#', 'a'], ['a.#', 'a.b.c'], ['#', 'x.y'], ['*.b', 'a.b']];
  const no = [['a.b', 'a.b.c'], ['a.*', 'a'], ['a.*.c', 'a.c'], ['a.b', 'a.c']];
  for (const [p, k] of yes) assert.ok(topicMatch(p, k), `${p} matches ${k}`);
  for (const [p, k] of no) assert.ok(!topicMatch(p, k), `${p} does not match ${k}`);
});
