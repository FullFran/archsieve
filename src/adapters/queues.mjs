import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { byKey } from '../util.mjs';
import { args } from './routes.mjs';

// Message-queue links (ADR 0007): producers and consumers of RabbitMQ (AMQP) exchanges, routing keys
// and queues, and of BullMQ queues, matched by name across containers. Read as text, not parsed: a
// call counts when its name is a string literal, a constant (same file, imported file, or the same
// container for Python attributes) or an environment default (`os.getenv("X", "lit")`,
// `process.env.X ?? 'lit'`). A name that cannot be resolved is an unknown finding, never a guess.
export const TOOL = 'archsieve queues';
const MAX_EVIDENCE = 5;
const JS_GATE = /amqplib|amqp-connection-manager|bullmq/;
const PY_GATE = /\b(aio_pika|pika|aiormq|kombu)\b/;
const within = (file, dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`);
const sortKey = (e) => `${e.file}\u0000${String(e.line).padStart(9, '0')}`;

// Comments replaced by spaces (newlines kept, so offsets and lines survive); strings are left alone.
function blankComments(text, lang) {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const triple = (c === '"' || c === "'") && lang === 'py' && text.startsWith(c.repeat(3), i);
    if (triple) {
      const end = text.indexOf(c.repeat(3), i + 3);
      const stop = end < 0 ? text.length : end + 3;
      out += text.slice(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || (c === '`' && lang === 'js')) {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(text[j] === '\n' && c !== '`')) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (lang === 'js' && c === '/' && text[i + 1] === '/') {
      const j = text.indexOf('\n', i);
      const stop = j < 0 ? text.length : j;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (lang === 'js' && c === '/' && text[i + 1] === '*') {
      const j = text.indexOf('*/', i + 2);
      const stop = j < 0 ? text.length : j + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (lang === 'py' && c === '#') {
      const j = text.indexOf('\n', i);
      const stop = j < 0 ? text.length : j;
      out += ' '.repeat(stop - i);
      i = stop;
    } else { out += c; i++; }
  }
  return out;
}

// The expression that starts at `i`: up to a newline, comma or closing bracket at depth zero.
function exprAt(text, i) {
  let depth = 0, quote = null, j = i;
  for (; j < text.length; j++) {
    const c = text[j];
    if (quote) { if (c === '\\') j++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
    else if (depth === 0 && (c === ',' || c === '\n' || c === ';')) break;
  }
  return text.slice(i, j).trim();
}

// Splits at top-level occurrences of any separator string.
function splitTop(expr, seps) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) { cur += c; if (c === '\\') cur += expr[++i] ?? ''; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    const sep = depth === 0 && seps.find((s) => expr.startsWith(s, i));
    if (sep) { parts.push(cur.trim()); cur = ''; i += sep.length - 1; continue; }
    cur += c;
  }
  parts.push(cur.trim());
  return parts;
}

const JS_STRING = /^(['"`])((?:(?!\1)[^\\$\n]|\\.)*)\1$/;
const PY_STRING = /^[rbRB]?(['"])((?:(?!\1)[^\\\n]|\\.)*)\1$/;
const PY_ENV = /^(?:os\.getenv|os\.environ\.get|getenv|environ\.get)\s*\(([\s\S]*)\)$/;

// Value of an expression, or null. `lookup(name)` resolves identifiers and attribute names.
function evalExpr(expr, lang, lookup, depth = 0) {
  let e = expr.trim();
  if (!e || depth > 6) return null;
  if (lang === 'js') {
    e = e.replace(/\s+as\s+[\w.<>\[\]|]+$/, '').replace(/!$/, '');
    while (e.startsWith('(') && e.endsWith(')') && splitTop(e.slice(1, -1), ['??', '||']).length >= 1 && !/\)\s*[(.]/.test(e.slice(1))) e = e.slice(1, -1).trim();
    const alt = splitTop(e, ['??', '||']);
    if (alt.length > 1) {
      for (const part of alt.reverse()) { const v = evalExpr(part, lang, lookup, depth + 1); if (v !== null) return v; }
      return null;
    }
    const s = JS_STRING.exec(e);
    if (s) return s[2];
    const m = /^(?:this\.)?([\w$]+)$/.exec(e);
    return m ? lookup(m[1], false, depth) : null;
  }
  const alt = splitTop(e, [' or ']);
  if (alt.length > 1) {
    for (const part of alt.reverse()) { const v = evalExpr(part, lang, lookup, depth + 1); if (v !== null) return v; }
    return null;
  }
  const s = PY_STRING.exec(e);
  if (s) return s[2];
  const env = PY_ENV.exec(e);
  if (env) {
    const a = args(env[1] + ')', 0);
    return a[1] === undefined ? null : evalExpr(a[1], lang, lookup, depth + 1);
  }
  const str = /^str\s*\(([\s\S]*)\)$/.exec(e);
  if (str) return evalExpr(str[1], lang, lookup, depth + 1);
  const m = /^(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)$/.exec(e);
  return m ? lookup(m[1], e.includes('.'), depth) : null;
}

// Named values in a file: JS const/let/var/readonly members, Python assignments, annotated fields and
// keyword arguments. A name given two different values is ambiguous, never resolved.
function declarations(text, lang) {
  const re = lang === 'js'
    ? /(?:\b(?:const|let|var)\s+|\b(?:private|public|protected|static|readonly)\s+(?:(?:static|readonly)\s+)*)([\w$]+)\s*(?::\s*[\w<>\[\]|. ]+?)?\s*=(?![=>])\s*/g
    : /(?<![=!<>\w.])([A-Za-z_]\w*)\s*(?::\s*[\w\[\], .|"']+?)?\s*=(?!=)\s*/g;
  const out = [];
  for (const m of text.matchAll(re)) out.push({ name: m[1], expr: exprAt(text, m.index + m[0].length), at: m.index });
  return out;
}

const lineOf = (text, i) => text.slice(0, i).split('\n').length;

// Where a function declaration starts that encloses `at`, with its name and parameter names.
function enclosingFunction(text, at, lang) {
  const re = lang === 'js'
    ? /(?:^|\n)[ \t]*(?:(?:export|default|private|public|protected|static|async|readonly)\s+)*(?:function\s+)?([\w$]+)\s*\(([^)]*)\)\s*(?::\s*[^{=;]+?)?\s*\{/g
    : /(?:^|\n)[ \t]*(?:async\s+)?def\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:->[^:]+)?:/g;
  let found = null;
  for (const m of text.slice(0, at).matchAll(re)) {
    if (lang === 'js' && /^(if|for|while|switch|catch|return|constructor|super|function)$/.test(m[1])) continue;
    found = { name: m[1], params: splitTop(m[2], [',']).map((p) => p.replace(/^(?:\*{1,2}|\.\.\.)/, '').replace(/^(?:readonly|private|public|protected)\s+/, '').split(/[:=?\s]/)[0]).filter(Boolean) };
  }
  return found;
}

// Call sites of a local function and the value passed for parameter `param`.
function wrapperValues(text, fn, param, lang, lookup) {
  const index = fn.params.indexOf(param);
  const out = [];
  for (const m of text.matchAll(new RegExp(`(?<![\\w$])${fn.name.replace(/\$/g, '\\$')}\\s*\\(`, 'g'))) {
    // The declaration of the function is not a call.
    if (/(?:function|def)\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    const a = args(text, m.index + m[0].length);
    let expr;
    if (lang === 'py') {
      const kw = a.find((x) => new RegExp(`^${param}\\s*=(?!=)`).test(x));
      expr = kw ? kw.replace(/^\w+\s*=\s*/, '') : a[index];
    } else expr = a[index];
    const v = expr === undefined ? null : evalExpr(expr, lang, lookup);
    if (v !== null) out.push({ value: v, at: m.index });
  }
  return out;
}

export const topicMatch = (pattern, key) => {
  const p = pattern.split('.'), k = key.split('.');
  const go = (i, j) => (i === p.length ? j === k.length : p[i] === '#' ? [...Array(k.length - j + 1).keys()].some((n) => go(i + 1, j + n)) : j < k.length && (p[i] === '*' || p[i] === k[j]) && go(i + 1, j + 1));
  return go(0, 0);
};

// Returns runtime-link edges (producer container -> consumer container, relations amqp / bullmq),
// findings, and the analyses entry.
export function queueLinks(root, snapshot, { pyFiles = [] } = {}) {
  const units = snapshot.nodes.filter((n) => n.kind === 'container');
  const deepest = [...units].sort(byKey((u) => String(1e6 - u.path.length).padStart(7, '0') + u.path));
  const unitOf = (file) => deepest.find((u) => within(file, u.path));
  const jsFiles = snapshot.nodes.filter((n) => n.kind === 'file' && !n.test && /\.(m|c)?(j|t)sx?$/.test(n.id)).map((n) => n.id);
  const importsOf = new Map();
  for (const e of snapshot.edges) if (e.kind === 'imports') (importsOf.get(e.source) ?? importsOf.set(e.source, []).get(e.source)).push(e.target);

  const cache = new Map();
  const load = (file, lang) => {
    if (!cache.has(file)) {
      let raw = null;
      try { raw = readFileSync(join(root, file), 'utf8'); } catch { /* unreadable */ }
      const text = raw === null ? null : blankComments(raw, lang);
      cache.set(file, { raw, text, lang, decls: text === null ? [] : declarations(text, lang) });
    }
    return cache.get(file);
  };
  // A file's own names: name -> value, or undefined when the file gives it different values.
  const localMap = (file, lang) => {
    const f = load(file, lang);
    if (f.local) return f.local;
    const values = new Map();
    f.local = values;
    for (let pass = 0; pass < 2; pass++) {
      const next = new Map();
      for (const d of f.decls) {
        const v = evalExpr(d.expr, lang, (n) => (values.has(n) ? values.get(n) : null));
        if (v === null || v === '') continue;
        next.set(d.name, next.has(d.name) && next.get(d.name) !== v ? undefined : v);
      }
      values.clear();
      for (const [k, v] of next) if (v !== undefined) values.set(k, v);
    }
    return values;
  };
  // Python: direct literal or env-default values by name across a container (attribute access).
  const containerIndex = new Map();
  const indexOf = (unit) => {
    if (containerIndex.has(unit.id)) return containerIndex.get(unit.id);
    const idx = new Map();
    for (const file of pyFiles.filter((f) => unitOf(f) === unit)) {
      for (const d of load(file, 'py').decls) {
        if (!/^(?:[rbRB]?['"]|(?:os\.getenv|os\.environ\.get|getenv|environ\.get)\s*\()/.test(d.expr)) continue;
        const v = evalExpr(d.expr, 'py', () => null);
        if (v === null || v === '') continue; // an empty default names nothing
        if (!idx.has(d.name)) idx.set(d.name, new Set());
        idx.get(d.name).add(v);
      }
    }
    containerIndex.set(unit.id, idx);
    return idx;
  };
  const importedValue = (file, name) => {
    const found = new Set();
    for (const target of importsOf.get(file) ?? []) {
      if (!/\.(m|c)?(j|t)sx?$/.test(target)) continue;
      const v = localMap(target, 'js').get(name);
      if (v !== undefined) found.add(v);
    }
    return found.size === 1 ? [...found][0] : null;
  };

  const endpoints = [], unresolved = new Map();
  let read = 0;
  const unknown = (file, line, detail) => {
    if (!unresolved.has(file)) unresolved.set(file, []);
    unresolved.get(file).push({ tool: TOOL, file, line, detail });
  };

  const scanFile = (file, lang) => {
    const f = load(file, lang);
    if (f.text === null || !(lang === 'js' ? JS_GATE : PY_GATE).test(f.text)) return;
    const unit = unitOf(file);
    if (!unit) return;
    read++;
    const text = f.text, local = localMap(file, lang), lines = f.raw.split('\n');
    const evOf = (at) => ({ tool: TOOL, file, line: lineOf(text, at), detail: lines[lineOf(text, at) - 1]?.trim().slice(0, 160) ?? '' });
    const lookupFor = () => (name, attr) => {
      if (!attr && local.has(name)) return local.get(name);
      if (lang === 'js') return attr ? null : importedValue(file, name);
      if (attr && local.has(name)) return local.get(name);
      const vals = indexOf(unit).get(name);
      return vals?.size === 1 && (attr || /^[A-Z][A-Z0-9_]*$/.test(name)) ? [...vals][0] : null;
    };
    // Every value an expression takes at a call: its own, or, for a parameter of the enclosing
    // function, what the function's callers in this file pass (one hop).
    const values = (expr, at) => {
      const lookup = lookupFor();
      const v = evalExpr(expr, lang, lookup);
      if (v !== null) return [{ value: v, at }];
      const ident = lang === 'js' ? /^(?:this\.)?([\w$]+)$/.exec(expr.trim())?.[1] : /^([A-Za-z_]\w*)$/.exec(expr.trim())?.[1];
      const fn = ident && enclosingFunction(text, at, lang);
      if (!fn || !fn.params.includes(ident)) return [];
      return wrapperValues(text, fn, ident, lang, lookup).map((w) => ({ value: w.value, at: w.at }));
    };
    const exprOf = (a, i, name) => {
      if (lang === 'py') {
        const kw = a.find((x) => new RegExp(`^${name}\\s*=(?!=)`).test(x));
        if (kw) return kw.replace(/^\w+\s*=\s*/, '');
      }
      return a[i];
    };
    const add = (e) => endpoints.push({ unit, file, ...e });
    // Values for a name expression; one that cannot be resolved is an unknown line.
    const resolveAt = (expr, at) => {
      const vs = expr === undefined ? [] : values(expr, at);
      if (!vs.length) unknown(file, lineOf(text, at), lines[lineOf(text, at) - 1]?.trim().slice(0, 160));
      return vs;
    };
    const optional = (expr) => (expr === undefined ? null : evalExpr(expr, lang, lookupFor()));

    const calls = (re, fn) => {
      for (const m of text.matchAll(re)) fn(m, args(text, m.index + m[0].length), m.index);
    };
    if (lang === 'js') {
      const amqp = /amqplib|amqp-connection-manager/.test(text), bull = /bullmq/.test(text);
      if (amqp) {
        calls(/\.publish\s*\(/g, (m, a, at) => {
          if (a.length < 3) return;
          const exchange = optional(a[0]);
          for (const v of resolveAt(a[1], at)) add({ kind: 'amqp', role: 'producer', target: exchange === '' ? 'queue' : 'key', name: v.value, exchange, ev: evOf(v.at) });
        });
        calls(/\.sendToQueue\s*\(/g, (m, a, at) => {
          for (const v of resolveAt(a[0], at)) add({ kind: 'amqp', role: 'producer', target: 'queue', name: v.value, ev: evOf(v.at) });
        });
        calls(/\.consume\s*\(/g, (m, a, at) => {
          const vs = resolveAt(a[0], at);
          for (const v of vs) add({ kind: 'amqp', role: 'consumer', queue: v.value, keys: [], ev: evOf(v.at), at });
        });
        calls(/\.bindQueue\s*\(/g, (m, a, at) => {
          const q = optional(a[0]);
          for (const v of resolveAt(a[2], at)) add({ kind: 'amqp', role: 'bind', queue: q, key: v.value, exchange: optional(a[1]), ev: evOf(v.at) });
        });
      }
      if (bull) {
        calls(/\bnew\s+(Queue|Worker)\b(?:\s*<[^(]*>)?\s*\(/g, (m, a, at) => {
          for (const v of resolveAt(a[0], at)) add({ kind: 'bullmq', role: m[1] === 'Queue' ? 'producer' : 'consumer', name: v.value, ev: evOf(v.at) });
        });
      }
      if (/@nestjs\/bullmq|@nestjs\/bull\b/.test(text)) {
        calls(/@(Processor|InjectQueue)\s*\(/g, (m, a, at) => {
          if (!JS_STRING.test(a[0] ?? '') && !/^[\w$.]+$/.test(a[0] ?? '')) return;
          for (const v of resolveAt(a[0], at)) add({ kind: 'bullmq', role: m[1] === 'Processor' ? 'consumer' : 'producer', name: v.value, ev: evOf(at) });
        });
      }
    } else {
      const vars = new Map();
      for (const m of text.matchAll(/([A-Za-z_]\w*)\s*=\s*await\s+[\w.]+\.declare_queue\s*\(/g)) vars.set(m[1], args(text, m.index + m[0].length));
      const queueOf = (name) => { const a = vars.get(name); return a ? optional(exprOf(a, 0, 'name')) : null; };
      calls(/(\b[\w.]*)\.publish\s*\(/g, (m, a, at) => {
        const rk = exprOf(a, 1, 'routing_key');
        if (rk === undefined) return;
        const dflt = /default_exchange$/.test(m[1]);
        for (const v of resolveAt(rk, at)) add({ kind: 'amqp', role: 'producer', target: dflt ? 'queue' : 'key', name: v.value, ev: evOf(v.at) });
      });
      calls(/\.basic_publish\s*\(/g, (m, a, at) => {
        const exchange = optional(exprOf(a, 0, 'exchange'));
        for (const v of resolveAt(exprOf(a, 1, 'routing_key'), at)) add({ kind: 'amqp', role: 'producer', target: exchange === '' ? 'queue' : 'key', name: v.value, exchange, ev: evOf(v.at) });
      });
      calls(/(\b\w+)\.bind\s*\(/g, (m, a, at) => {
        if (!vars.has(m[1])) return;
        for (const v of resolveAt(exprOf(a, 1, 'routing_key'), at)) add({ kind: 'amqp', role: 'bind', queue: queueOf(m[1]), key: v.value, exchange: optional(exprOf(a, 0, 'exchange')), ev: evOf(v.at), via: m[1] });
      });
      calls(/(\b\w+)\.(?:consume|iterator)\s*\(/g, (m, a, at) => {
        if (!vars.has(m[1])) return;
        const q = queueOf(m[1]);
        if (q === null) unknown(file, lineOf(text, at), lines[lineOf(text, at) - 1]?.trim().slice(0, 160));
        else add({ kind: 'amqp', role: 'consumer', queue: q, keys: [], ev: evOf(at), via: m[1] });
      });
      calls(/\.basic_consume\s*\(/g, (m, a, at) => {
        for (const v of resolveAt(exprOf(a, 0, 'queue'), at)) add({ kind: 'amqp', role: 'consumer', queue: v.value, keys: [], ev: evOf(at) });
      });
    }
  };

  for (const f of jsFiles) scanFile(f, 'js');
  const pyGated = pyFiles.filter((f) => { const x = load(f, 'py'); return x.text !== null && PY_GATE.test(x.text); });
  for (const f of pyGated) scanFile(f, 'py');

  // Subscriptions: a consume call, with the routing keys bound to its queue in the same file. A bind
  // with no consume of that queue in the file belongs to someone else's queue and is not a consumer.
  const subs = [];
  for (const c of endpoints.filter((e) => e.role === 'consumer' && e.kind === 'amqp')) {
    const keys = endpoints.filter((b) => b.role === 'bind' && b.file === c.file && b.queue === c.queue).map((b) => ({ key: b.key, exchange: b.exchange, ev: b.ev }));
    subs.push({ ...c, keys });
  }
  const bullProducers = endpoints.filter((e) => e.kind === 'bullmq' && e.role === 'producer');
  const bullConsumers = endpoints.filter((e) => e.kind === 'bullmq' && e.role === 'consumer');
  const amqpProducers = endpoints.filter((e) => e.kind === 'amqp' && e.role === 'producer');
  const exchangeClash = (a, b) => typeof a === 'string' && a !== '' && typeof b === 'string' && b !== '' && a !== b;
  const amqpMatch = (p, s) => (p.target === 'queue' ? s.queue === p.name : s.keys.some((k) => !exchangeClash(p.exchange, k.exchange) && topicMatch(k.key, p.name)));

  const links = new Map();
  const addLink = (p, c, kind, evidence) => {
    if (p.unit === c.unit) return;
    const k = `${p.unit.id}\u0000${c.unit.id}`;
    if (!links.has(k)) links.set(k, { source: p.unit.id, target: c.unit.id, kind: 'runtime-link', relations: {}, confidence: 'pattern', evidence: [] });
    const l = links.get(k);
    l.relations[kind] = (l.relations[kind] ?? 0) + 1;
    l.evidence.push(...evidence);
  };
  const signals = [];
  const label = (kind, names) => `${kind} ${names.join(', ')}`;
  // AMQP
  for (const p of amqpProducers) {
    const hits = subs.filter((s) => amqpMatch(p, s));
    for (const s of hits) addLink(p, s, 'amqp', [p.ev, s.keys.find((k) => p.target === 'key' && topicMatch(k.key, p.name))?.ev ?? s.ev]);
  }
  const producerSeen = new Set();
  for (const p of amqpProducers) {
    if (subs.some((s) => amqpMatch(p, s))) continue;
    const id = `amqp:${p.target}:${p.name}`;
    producerSeen.add(id);
    signals.push({ rule: 'queue-producer-without-consumer', subject: id, ev: p.ev, message: `${p.file} publishes to ${p.target === 'queue' ? 'queue' : 'routing key'} "${p.name}" and no consumer in the repository binds or reads it. The consumer may live outside the repository.` });
  }
  for (const s of subs) {
    if (amqpProducers.some((p) => amqpMatch(p, s))) continue;
    const names = [s.queue, ...s.keys.map((k) => k.key)].filter(Boolean);
    signals.push({ rule: 'queue-consumer-without-producer', subject: `amqp:${s.queue ?? names[0]}`, ev: s.ev, message: `${s.file} consumes ${label('queue', [s.queue ?? '(unnamed)'])}${s.keys.length ? ` bound to ${s.keys.map((k) => k.key).join(', ')}` : ''} and no producer in the repository publishes to it. The producer may live outside the repository.` });
  }
  // BullMQ
  for (const p of bullProducers) {
    const hits = bullConsumers.filter((c) => c.name === p.name);
    for (const c of hits) addLink(p, c, 'bullmq', [p.ev, c.ev]);
    if (!hits.length) signals.push({ rule: 'queue-producer-without-consumer', subject: `bullmq:${p.name}`, ev: p.ev, message: `${p.file} adds jobs to BullMQ queue "${p.name}" and no Worker in the repository processes it.` });
  }
  for (const c of bullConsumers) {
    if (!bullProducers.some((p) => p.name === c.name)) signals.push({ rule: 'queue-consumer-without-producer', subject: `bullmq:${c.name}`, ev: c.ev, message: `${c.file} processes BullMQ queue "${c.name}" and no Queue in the repository adds jobs to it.` });
  }

  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  const edges = [...links.values()].map((l) => {
    const ev = [...new Map(l.evidence.map((x) => [`${x.file}:${x.line}`, x])).values()].sort(byKey(sortKey));
    return { ...l, relations: sorted(l.relations), evidence: ev.length > MAX_EVIDENCE ? [...ev.slice(0, MAX_EVIDENCE), { tool: TOOL, detail: `${ev.length - MAX_EVIDENCE} more` }] : ev };
  });
  const findings = [];
  const bySubject = new Map();
  for (const s of signals) {
    const k = `${s.rule}\u0000${s.subject}`;
    if (!bySubject.has(k)) bySubject.set(k, { level: 'signal', rule: s.rule, subjects: [s.subject], message: s.message, evidence: [] });
    const f = bySubject.get(k);
    if (!f.evidence.some((x) => x.file === s.ev.file && x.line === s.ev.line)) f.evidence.push(s.ev);
  }
  findings.push(...bySubject.values());
  for (const [file, ev] of unresolved) {
    const uniq = [...new Map(ev.map((x) => [x.line, x])).values()].sort(byKey((x) => String(x.line).padStart(9, '0')));
    findings.push({ level: 'unknown', rule: 'queue-name-unresolved', subjects: [file], message: `${uniq.length === 1 ? 'A queue or routing-key name' : `${uniq.length} queue or routing-key names`} in ${file} ${uniq.length === 1 ? 'is' : 'are'} not a literal, a constant or an environment default: the message link, if any, is not visible statically.`, evidence: uniq });
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const analysis = {
    tool: TOOL, scope: 'RabbitMQ (AMQP) and BullMQ producers and consumers', status: 'ok',
    note: `${plural(edges.length, 'queue link', 'queue links')}; ${plural(amqpProducers.length, 'AMQP producer', 'AMQP producers')}, ${plural(subs.length, 'AMQP consumer', 'AMQP consumers')}, ${plural(bullProducers.length, 'BullMQ producer', 'BullMQ producers')}, ${plural(bullConsumers.length, 'BullMQ consumer', 'BullMQ consumers')}; ${plural(findings.filter((f) => f.rule === 'queue-name-unresolved').reduce((s, f) => s + f.evidence.length, 0), 'unresolved name', 'unresolved names')}; read ${read} JS/TS and Python files that name a message-queue library`,
  };
  return { edges, findings, analysis };
}
