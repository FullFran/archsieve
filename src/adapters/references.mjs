import { readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { byKey } from '../util.mjs';
import { languageOf } from './facts.mjs';

// Repository paths named in comments, string literals and docs (#10, ADR 0006): `references` edges
// at pattern confidence, file to file, kept apart from imports in every view and in `affected`. A
// reference whose line says the code mirrors / copies / follows the same rule as a file in another
// language or container is a `mirrored-logic` signal: a hint for a human, not proof of duplication.
export const TOOL = 'archsieve patterns';
const MAX_EVIDENCE = 5;
const MAX_READ = 1024 * 1024;
// Code and prose that can carry a path reference; config, data and lockfiles are left out.
const SOURCES = new Set(['typescript', 'javascript', 'go', 'rust', 'python', 'ruby', 'php', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'scala',
  'powershell', 'shell', 'vue', 'svelte', 'sql', 'css', 'html', 'make', 'dockerfile', 'markdown']);
const PROSE = new Set(['markdown']);
const PATH_TOKEN = /(?:\.{1,2}\/)*[\w@-][\w@.-]*(?:\/[\w@.-]+)*\/[\w@-][\w@.-]*\.\w+/g;
const COMMENT = /\/\/|\/\*|^\s*\*|#|--|<!--/;
const MIRROR = /\b(mirror(s|ed|ing)?|same (rules?|logic|checks?|algorithm|layout|format)( as)?|cop(y|ies|ied) (of|from)|(keep|kept|in) sync|must match|duplicate[sd]? (of|from|in)|port(ed)? (of|from))\b/i;

// In a code file, a token counts only inside a comment or a string literal.
function quotedOrCommented(line, i) {
  const before = line.slice(0, i);
  if (COMMENT.test(before)) return true;
  return ['"', "'", '`'].some((q) => before.split(q).length % 2 === 0);
}

export function pathReferences(root, files, { units = [], imports = [] } = {}) {
  const tracked = new Set(files);
  const deepest = [...units].sort(byKey((u) => String(1e6 - u.path.length).padStart(7, '0') + u.path));
  const unitOf = (f) => deepest.find((u) => u.path === '.' || f.startsWith(`${u.path}/`))?.id;
  const imported = new Set(imports.map((e) => `${e.source}\u0000${e.target}`));
  const refs = new Map();
  let read = 0, asImport = 0;
  for (const file of files) {
    const lang = languageOf(file);
    if (!SOURCES.has(lang)) continue;
    let text;
    try {
      if (statSync(join(root, file)).size > MAX_READ) continue;
      text = readFileSync(join(root, file), 'utf8');
    } catch { continue; }
    if (!text.includes('/')) continue;
    read++;
    const seen = new Set();
    text.split('\n').forEach((line, n) => {
      for (const m of line.matchAll(PATH_TOKEN)) {
        if (!PROSE.has(lang) && !quotedOrCommented(line, m.index)) continue;
        const token = m[0];
        const target = [token.startsWith('.') ? null : posix.normalize(token), posix.normalize(posix.join(posix.dirname(file), token))].find((p) => p && tracked.has(p));
        if (!target || target === file) continue;
        const k = `${file}\u0000${target}`;
        if (imported.has(k)) { if (!seen.has(k)) { asImport++; seen.add(k); } continue; }
        if (!refs.has(k)) refs.set(k, { source: file, target, evidence: [], mirror: [] });
        const r = refs.get(k);
        const ev = { tool: TOOL, file, line: n + 1, detail: line.trim().slice(0, 160) };
        if (!r.evidence.some((x) => x.line === ev.line)) r.evidence.push(ev);
        if (MIRROR.test(line) && !r.mirror.some((x) => x.line === ev.line)) r.mirror.push(ev);
      }
    });
  }
  const all = [...refs.values()].sort(byKey((r) => `${r.source}\u0000${r.target}`));
  const edges = all.map((r) => ({
    source: r.source, target: r.target, kind: 'references', confidence: 'pattern',
    evidence: r.evidence.length > MAX_EVIDENCE ? [...r.evidence.slice(0, MAX_EVIDENCE), { tool: TOOL, detail: `${r.evidence.length - MAX_EVIDENCE} more` }] : r.evidence,
  }));
  const findings = [];
  for (const r of all) {
    if (!r.mirror.length) continue;
    const la = languageOf(r.source), lb = languageOf(r.target), ua = unitOf(r.source), ub = unitOf(r.target);
    const crossLang = la !== lb, crossUnit = ua && ub && ua !== ub;
    if (!crossLang && !crossUnit) continue;
    const across = [crossLang ? `${la} -> ${lb}` : null, crossUnit ? `${ua} -> ${ub}` : null].filter(Boolean).join('; ');
    findings.push({
      level: 'signal', rule: 'mirrored-logic', subjects: [r.source, r.target],
      message: `${r.source}:${r.mirror[0].line} says it mirrors or follows the same rule as ${r.target} (${across}): the same logic may live in two places, so every change needs both and a test on each side. A hint from the wording, not proof of duplication.`,
      evidence: r.mirror,
    });
  }
  const sources = new Set(all.map((r) => r.source)).size;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return {
    edges, findings,
    analysis: { tool: 'path references', scope: 'comments, strings and docs', status: 'ok', note: `${plural(edges.length, 'reference')} from ${plural(sources, 'file')}; ${asImport} already an import, left out; ${read} files read` },
  };
}
