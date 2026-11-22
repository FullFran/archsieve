// A small TOML reader for manifests (pyproject.toml): tables, arrays of tables, dotted and quoted
// keys, strings (basic, literal, multi-line), numbers, booleans, arrays and inline tables. Dates are
// kept as strings. It reads data only and throws on malformed input; the caller reports that as an
// unknown finding.
export function parseToml(text) {
  let i = 0;
  const root = {};
  const fail = (msg) => { throw new SyntaxError(`TOML: ${msg} near offset ${i}`); };
  const ws = (nl) => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || (nl && c === '\n')) i++;
      else if (c === '#') while (i < text.length && text[i] !== '\n') i++;
      else return;
    }
  };
  const basic = (q) => {
    const triple = text.startsWith(q.repeat(3), i);
    i += triple ? 3 : 1;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      if (triple ? text.startsWith(q.repeat(3), i) : text[i] === q) { i += triple ? 3 : 1; return out; }
      if (!triple && text[i] === '\n') fail('newline in string');
      if (q === '"' && text[i] === '\\') {
        const e = text[i + 1];
        const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
        if (e in map) { out += map[e]; i += 2; }
        else if (e === 'u' || e === 'U') { const n = e === 'u' ? 4 : 8; out += String.fromCodePoint(parseInt(text.slice(i + 2, i + 2 + n), 16)); i += 2 + n; }
        else if (triple && /\s/.test(e)) { i++; while (/\s/.test(text[i] ?? '')) i++; }
        else fail('bad escape');
        continue;
      }
      out += text[i++];
    }
  };
  const key = () => {
    ws(false);
    const c = text[i];
    if (c === '"' || c === "'") return basic(c);
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 200));
    if (!m) fail('expected a key');
    i += m[0].length;
    return m[0];
  };
  const keyPath = () => {
    const path = [key()];
    for (ws(false); text[i] === '.'; ws(false)) { i++; path.push(key()); }
    return path;
  };
  const value = () => {
    ws(false);
    const c = text[i];
    if (c === '"' || c === "'") return basic(c);
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        ws(true);
        if (text[i] === ']') { i++; return arr; }
        arr.push(value());
        ws(true);
        if (text[i] === ',') i++;
        else if (text[i] !== ']') fail('expected , or ]');
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        ws(true);
        if (text[i] === '}') { i++; return obj; }
        const path = keyPath();
        ws(false);
        if (text[i++] !== '=') fail('expected =');
        assign(obj, path, value());
        ws(true);
        if (text[i] === ',') i++;
        else if (text[i] !== '}') fail('expected , or }');
      }
    }
    const m = /^[^\s,\]}#]+/.exec(text.slice(i, i + 200));
    if (!m) fail('expected a value');
    i += m[0].length;
    const s = m[0];
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(s)) return Number(s.replaceAll('_', ''));
    return s;
  };
  // Walks into nested tables; the last element of an array of tables is the current one.
  const descend = (obj, path) => path.reduce((o, k) => {
    const next = (o[k] ??= {});
    return Array.isArray(next) ? next[next.length - 1] : next;
  }, obj);
  const assign = (obj, path, v) => { descend(obj, path.slice(0, -1))[path.at(-1)] = v; };

  let table = root;
  for (;;) {
    ws(true);
    if (i >= text.length) return root;
    if (text[i] === '[') {
      const array = text[i + 1] === '[';
      i += array ? 2 : 1;
      const path = keyPath();
      ws(false);
      if (text.slice(i, i + (array ? 2 : 1)) !== (array ? ']]' : ']')) fail('unterminated table header');
      i += array ? 2 : 1;
      if (array) {
        const parent = descend(root, path.slice(0, -1));
        (parent[path.at(-1)] ??= []).push((table = {}));
      } else table = descend(root, path);
    } else {
      const path = keyPath();
      ws(false);
      if (text[i++] !== '=') fail('expected =');
      assign(table, path, value());
    }
    ws(false);
    if (i < text.length && text[i] !== '\n') fail('unexpected text after value');
  }
}
