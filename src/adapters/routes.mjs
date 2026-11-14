// HTTP route literals, read line by line (ADR 0006): route definitions on the server side and the
// path of client calls. Pure functions over one line; the pattern adapter matches them. Paths are
// normalised to segments, and every parameter or interpolation becomes the wildcard `*`.

const HOLE = '\u0000';

// Which files can hold a route or a client call at all.
export const HTTP_GATE = {
  js: /\bfetch\s*\(|\baxios\b|\bky\b|\bgot\b|@Controller\b|\.(get|post|put|patch|delete|all)\s*\(\s*['"`]\//,
  go: /\bhttp\.|\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|Any|HandleFunc|Handle)\s*\(/,
  rust: /reqwest|client|\.route\s*\(|#\[(get|post|put|patch|delete|head|route)\s*\(/i,
};

// `/users/:id`, `/users/{id}`, `/users/<id>` and `/users/${id}` are the same route: `/users/*`.
export function normalisePath(p) {
  const path = p.replace(/[?#].*$/, '');
  if (!path.startsWith('/')) return null;
  const segs = path.split('/').filter(Boolean).map((s) => (s.includes(HOLE) || /^[:*]|^\{.*\}$|^<.*>$/.test(s) ? '*' : s));
  return `/${segs.join('/')}`;
}

const JS_SERVER = /\b(?:app|router|server|fastify|api|routes?|r|hono|instance)\.(?:get|post|put|patch|delete|all|head|options)\s*\(\s*(['"`])(\/[^'"`$]*)\1/;
const NEST_METHOD = /@(?:Get|Post|Put|Patch|Delete|All|Head|Options)\s*\(\s*(?:(['"`])([^'"`]*)\1)?\s*\)/;
const GO_SERVER = /\b(\w+)\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|Any|Head)\s*\(\s*"([^"]+)"/;
const RUST_SERVER = /\.route\s*\(\s*"(\/[^"]*)"|#\[(?:get|post|put|patch|delete|head|route)\s*\(\s*"(\/[^"]*)"/;

// Route definitions on one line. `nestPrefix` is the file's @Controller path, when it has one.
export function serverRoutes(lang, line, { nestPrefix } = {}) {
  let raw = null;
  if (lang === 'js') {
    raw = JS_SERVER.exec(line)?.[2] ?? null;
    const nest = nestPrefix !== undefined && NEST_METHOD.exec(line);
    if (!raw && nest) raw = `/${[nestPrefix, nest[2] ?? ''].map((s) => s.replace(/^\/|\/$/g, '')).filter(Boolean).join('/')}`;
  } else if (lang === 'go') {
    const m = GO_SERVER.exec(line);
    // net/http's own Get/Post/Head are client calls; its HandleFunc/Handle register routes.
    if (m && !(m[1] === 'http' && !m[2].startsWith('Handle')) && !/client/i.test(m[1])) raw = m[3].replace(/^[A-Z]+\s+/, '');
  } else if (lang === 'rust') {
    const m = RUST_SERVER.exec(line);
    raw = m ? m[1] ?? m[2] : null;
  }
  const p = raw === null ? null : normalisePath(raw);
  return p ? [p] : [];
}

const CLIENT = {
  js: /\b(?:fetch|\$fetch|ofetch|ky|axios|got|superagent)(?:\.(?:get|post|put|patch|delete|head|request))?\s*\(/,
  go: /\b(?:http|\w*[cC]lient)\.(Get|Post|Head|PostForm|NewRequest|NewRequestWithContext)\s*\(/,
  rust: /\b(?:reqwest::(?:blocking::)?get|\w*client\w*\.(?:get|post|put|patch|delete|head|request))\s*\(/i,
};

// Top-level arguments of the call whose `(` ends at `start`.
function args(line, start) {
  const out = [];
  let depth = 0, quote = null, cur = '';
  for (let i = start; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += line[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { out.push(cur.trim()); return out; }
      depth--;
    }
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

// The URL an expression builds, with a hole wherever a value is not literal; null when no part of
// it is literal. Handles quotes and templates, `+` concatenation, fmt.Sprintf and format!.
function urlOf(expr) {
  const fmt = /^(?:fmt\.Sprintf|&?format!)\s*\(\s*"((?:[^"\\]|\\.)*)"/.exec(expr);
  if (fmt) return fmt[1].replace(/%[-+# 0-9.]*[a-zA-Z]/g, HOLE).replace(/\{\{|\}\}/g, '').replace(/\{[^}]*\}/g, HOLE);
  const parts = expr.split(/\s*\+\s*/);
  let literal = false;
  const url = parts.map((part) => {
    const q = /^(['"`])([\s\S]*)\1$/.exec(part.trim());
    if (!q) return HOLE;
    literal = true;
    return q[1] === '`' ? q[2].replace(/\$\{[^}]*\}/g, HOLE) : q[2];
  }).join('');
  return literal ? url : null;
}

// undefined: no client call on the line. Otherwise `{ path }`, null when the URL has no literal path.
export function clientCall(lang, line) {
  const m = CLIENT[lang]?.exec(line);
  if (!m) return undefined;
  const a = args(line, m.index + m[0].length);
  const fn = /(\w+)\s*\($/.exec(m[0])?.[1];
  const expr = lang === 'go' ? a[fn === 'NewRequestWithContext' ? 2 : fn === 'NewRequest' ? 1 : 0] : a[0];
  const url = expr ? urlOf(expr) : null;
  if (url === null) return { path: null };
  const rest = url.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '').replace(new RegExp(`^${HOLE}+`), '');
  const p = normalisePath(rest);
  return { path: p && p.split('/').some((s) => s && s !== '*') ? p : null };
}

export const clientPath = (lang, line) => clientCall(lang, line)?.path ?? null;

// Same number of segments, each equal or a wildcard on either side, and at least one literal
// segment that agrees: `/*` against `/*` says nothing.
export function routeMatch(route, call) {
  const a = route.split('/').filter(Boolean), b = call.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  let literal = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '*' || b[i] === '*') continue;
    if (a[i] !== b[i]) return false;
    literal++;
  }
  return literal > 0;
}
