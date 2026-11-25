import { readFileSync } from 'node:fs';
import { validate } from './validate.mjs';

// Declared dependency rules (#28, ADR 0008). The user declares them; ArchSieve never ships any.
// They match node ids, not syntax, so the same file covers JS/TS imports, Go packages and NestJS DI.
// Only edges a parser or the framework reported are checked: a pattern-confidence edge is never proof.
export const CHECKED_KINDS = ['imports', 'nest-imports', 'nest-injects'];
const TOOL = 'archsieve rules';

const badRules = (file, msg) => {
  const e = new Error(`rules file ${file}: ${msg}`);
  e.code = 'BAD_RULES';
  return e;
};

const list = (p) => (p === undefined ? [] : Array.isArray(p) ? p : [p]);

// Compiled once per pattern; to-patterns may hold $1..$9 and are compiled per from-match.
function compile(file, where, p, groups) {
  const src = groups ? p.replace(/\$([1-9])/g, (_, i) => (groups[i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : p;
  try { return new RegExp(src); } catch { throw badRules(file, `${where} is not a valid regular expression: ${p}`); }
}

function compileEnd(file, where, end) {
  return {
    path: list(end.path).map((p) => ({ raw: p, re: compile(file, `${where}.path`, p) })),
    pathNot: list(end.pathNot).map((p) => ({ raw: p, re: compile(file, `${where}.pathNot`, p) })),
  };
}

export function loadRules(file) {
  let text, doc;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw badRules(file, `cannot be read (${e.code ?? e.message})`); }
  try { doc = JSON.parse(text); } catch (e) { throw badRules(file, `is not valid JSON (${e.message})`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw badRules(file, 'must be a JSON object with forbidden or allowed rules');
  const errors = validate(doc, 'rules');
  if (errors.length) throw badRules(file, `does not match schema/rules.schema.json:\n${errors.join('\n')}`);
  const names = new Set();
  const forbidden = (doc.forbidden ?? []).map((r, i) => {
    if (names.has(r.name)) throw badRules(file, `duplicate rule name "${r.name}"`);
    names.add(r.name);
    return { ...r, where: `forbidden[${i}]`, from: compileEnd(file, `forbidden[${i}].from`, r.from), to: compileEnd(file, `forbidden[${i}].to`, r.to) };
  });
  const allowed = (doc.allowed ?? []).map((r, i) => ({ ...r, where: `allowed[${i}]`, from: compileEnd(file, `allowed[${i}].from`, r.from), to: compileEnd(file, `allowed[${i}].to`, r.to) }));
  return { file, forbidden, allowed: doc.allowed ? allowed : null };
}

// Whether the edge matches the rule; to-patterns see the groups of the first from.path that matched.
function matches(rule, edge) {
  let groups = null;
  if (rule.from.path.length) {
    const m = rule.from.path.map((p) => p.re.exec(edge.source)).find(Boolean);
    if (!m) return false;
    groups = m;
  }
  if (rule.from.pathNot.some((p) => p.re.test(edge.source))) return false;
  const re = (p) => (groups && /\$[1-9]/.test(p.raw) ? compile('', '', p.raw, groups) : p.re);
  if (rule.to.path.length && !rule.to.path.some((p) => re(p).test(edge.target))) return false;
  if (rule.to.pathNot.some((p) => re(p).test(edge.target))) return false;
  return true;
}

// One error finding per (rule, edge). Its evidence is the edge's own evidence plus the rule that it breaks.
export function checkRules(snapshot, rules) {
  const findings = [];
  const edges = snapshot.edges.filter((e) => CHECKED_KINDS.includes(e.kind));
  const finding = (rule, where, edge, why) => ({
    level: 'error', rule, subjects: [edge.source, edge.target],
    message: `${rule}: ${edge.source} -> ${edge.target}${why ? ` (${why})` : ''}`,
    evidence: [...edge.evidence, { tool: TOOL, file: rules.file, detail: where }],
  });
  for (const e of edges) {
    for (const r of rules.forbidden) if (matches(r, e)) findings.push(finding(r.name, r.where, e, r.comment));
    if (rules.allowed && !rules.allowed.some((r) => matches(r, e))) findings.push(finding('not-in-allowed', 'allowed', e, 'matches no allowed rule'));
  }
  // The same pair may come through several edge kinds: one finding per rule and pair.
  const seen = new Map();
  for (const f of findings) {
    const k = `${f.rule}\u0000${f.subjects.join('\u0000')}`;
    const prev = seen.get(k);
    if (!prev) { seen.set(k, f); continue; }
    const ev = new Map([...prev.evidence, ...f.evidence].map((x) => [JSON.stringify(x), x]));
    prev.evidence = [...ev.values()];
  }
  return [...seen.values()];
}

export const rulesNote = (rules, n) => `${rules.forbidden.length} forbidden, ${rules.allowed?.length ?? 0} allowed; ${n} violation${n === 1 ? '' : 's'} over ${CHECKED_KINDS.join(', ')} edges`;
