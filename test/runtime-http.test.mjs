import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cli, scratch, fixture, readJson } from './helpers.mjs';
import { serverRoutes, clientPath, routeMatch } from '../src/adapters/patterns.mjs';

// fixtures/runtime-http: web/src/client.ts calls /users/:id (served by the Express app in api/),
// /reports/:id (served by the Go service in svc/), /health (served by both: ambiguous), an
// external URL and a URL with no literal path. The Tauri shell calls /reports/{} with reqwest.
function scanHttp(t, extra = []) {
  const out = join(scratch(t), 'snap.json');
  const r = cli(['scan', fixture('runtime-http'), '--go', 'none', '-o', out, ...extra]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cli(['validate', out]).code, 0, 'snapshot is schema-valid');
  return { file: out, snap: readJson(out) };
}

test('S6 scan: a client call whose literal path matches exactly one container\'s route is an http-route runtime link', (t) => {
  const { snap } = scanHttp(t);
  const links = snap.edges.filter((e) => e.kind === 'runtime-link').map((e) => [e.source, e.target, e.relations, e.evidence.map((x) => `${x.file}:${x.line}`)]);
  assert.deepEqual(links, [
    ['container:shell/src-tauri', 'container:svc', { 'http-route': 1 }, ['shell/src-tauri/src/main.rs:2', 'svc/main.go:6']],
    ['container:web', 'container:api', { 'http-route': 1 }, ['api/server.mjs:4', 'web/src/client.ts:3']],
    ['container:web', 'container:svc', { 'http-route': 1 }, ['svc/main.go:6', 'web/src/client.ts:4']],
  ]);
  const note = snap.analyses.find((a) => a.tool === 'archsieve patterns').note;
  assert.match(note, /HTTP: 4 routes in 2 containers; 3 calls matched, 1 ambiguous, 1 matched no route, 1 without a literal path/);
});

test('S6 scan --model: an HTTP route match evidences a declared HTTP link, not a declared child-process one', (t) => {
  const { snap } = scanHttp(t, ['--model', fixture('runtime-http', 'architecture', 'model.likec4.json')]);
  const status = (target) => snap.edges.find((e) => e.kind === 'depends-on' && e.source === 'container:web' && e.target === target).status;
  assert.equal(status('container:api'), 'evidenced');
  assert.equal(status('container:svc'), 'declared-unverified');
});

test('S6 patterns: route definitions per framework, normalised to segments with wildcards', () => {
  const cases = [
    ['js', "router.post('/orders/:orderId/items', h)", ['/orders/*/items']],
    ['js', "fastify.get('/a/b', h)", ['/a/b']],
    ['go', 'r.GET("/v1/users/:id", h)', ['/v1/users/*']],
    ['go', 'mux.HandleFunc("POST /jobs/{id}/run", h)', ['/jobs/*/run']],
    ['go', 'r.Get("/items/{id}", h)', ['/items/*']],
    ['rust', '.route("/api/things/{id}", get(show))', ['/api/things/*']],
    ['rust', '.route("/api/things/:id", get(show))', ['/api/things/*']],
    ['rust', '#[get("/stats/<day>")]', ['/stats/*']],
    ['js', "axios.get('/users/1')", []],
    ['go', 'resp, err := http.Get("http://localhost/x")', []],
    ['js', "cache.get('key')", []],
  ];
  for (const [lang, line, want] of cases) assert.deepEqual(serverRoutes(lang, line), want, line);
});

test('S6 patterns: client call paths, with base URLs and interpolations reduced to wildcards', () => {
  const cases = [
    ['js', "axios.post(`${BASE}/orders/${id}/items`, body)", '/orders/*/items'],
    ['js', "fetch('http://localhost:3000/api/v2/users?x=1')", '/api/v2/users'],
    ['js', 'fetch(url)', null],
    ['js', "fetch('/')", null],
    ['go', 'resp, err := http.Get(base + "/v1/users/" + id)', '/v1/users/*'],
    ['go', 'req, _ := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/jobs/%d/run", base, id), nil)', '/jobs/*/run'],
    ['rust', 'client.post(format!("{base}/api/things/{}", id)).send()', '/api/things/*'],
    ['rust', 'map.get("key")', null],
  ];
  for (const [lang, line, want] of cases) assert.equal(clientPath(lang, line), want, line);
  assert.ok(routeMatch('/users/*', '/users/*'));
  assert.ok(routeMatch('/users/*', '/users/me'));
  assert.ok(!routeMatch('/users/*/x', '/users/*'));
  assert.ok(!routeMatch('/*', '/*'), 'at least one literal segment must agree');
});
