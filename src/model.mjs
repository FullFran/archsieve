import { existsSync } from 'node:fs';
import { join, posix, relative, resolve, basename, isAbsolute } from 'node:path';
import { byKey } from './util.mjs';

// Cross-check between a declared model (neutral shape, see adapters/likec4.mjs) and the observed
// units and links. States: confirmed, declared-unverified, undeclared. There is no score.

const normPath = (p) => {
  if (typeof p !== 'string') return null;
  const n = posix.normalize(p.replaceAll('\\', '/')).replace(/\/+$/, '');
  if (n === '' || n === '.' || n === './') return '.';
  if (posix.isAbsolute(n) || n === '..' || n.startsWith('../')) return null;
  return n.replace(/^\.\//, '');
};
const within = (file, dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`);
const sortEvidence = (ev) => [...new Map(ev.map((x) => [JSON.stringify(x), x])).values()].sort(byKey((x) => JSON.stringify(x)));

export function modelEvidenceFile(root, modelFile) {
  const rel = relative(root, resolve(modelFile)).replaceAll('\\', '/');
  return rel.startsWith('..') || isAbsolute(rel) ? basename(modelFile) : rel;
}

// Before linking: declared paths become units (so their files leave the enclosing unit), and the
// units get their declared counterpart. Mutates `units`; returns new system nodes, findings and
// the declared links resolved to node ids.
export function applyModel(root, units, model, evFile) {
  const ev = (detail) => ({ tool: model.format, file: evFile, detail });
  const findings = [], nodeOf = new Map(), systems = new Map(), declaredPaths = [];
  const byPath = new Map(units.map((u) => [u.path, u]));
  const elements = [...model.elements].sort(byKey((e) => e.id));
  const byId = new Map(elements.map((e) => [e.id, e]));
  const declaredOf = (e) => ({ id: e.id, title: e.title, ...(e.technology ? { technology: e.technology } : {}), ...(e.parent ? { parent: e.parent } : {}) });

  for (const e of elements) {
    if (e.path === undefined) continue;
    const path = normPath(e.path);
    if (path === null) {
      findings.push({ level: 'unknown', rule: 'declared-path-invalid', subjects: [e.id], message: `Declared element ${e.id} has a path that is not a relative directory inside the repository.`, evidence: [ev(e.id)] });
      continue;
    }
    let u = byPath.get(path);
    if (u?.declared) {
      findings.push({ level: 'signal', rule: 'declared-path-duplicate', subjects: [u.id], message: `Declared elements ${u.declared.id} and ${e.id} both claim path '${path}'; the first one is used.`, evidence: [ev(e.id)] });
      nodeOf.set(e.id, u.id);
      continue;
    }
    if (u) {
      Object.assign(u, { declared: declaredOf(e), status: 'confirmed', evidence: sortEvidence([...u.evidence, ev(e.id)]) });
    } else {
      u = { id: `container:${path}`, kind: 'container', path, title: e.title, technology: [], runnable: false, declared: declaredOf(e), status: 'declared-unverified', evidence: [ev(e.id)] };
      units.push(u);
      byPath.set(path, u);
      if (!existsSync(join(root, path))) {
        findings.push({ level: 'signal', rule: 'declared-path-missing', subjects: [u.id], message: `Declared element ${e.id} points to '${path}', which does not exist in the repository.`, evidence: [ev(e.id)] });
      }
    }
    nodeOf.set(e.id, u.id);
    declaredPaths.push(path);
  }

  for (const u of units) {
    if (u.declared || declaredPaths.some((p) => p !== u.path && within(u.path, p) && p !== '.')) continue;
    u.status = 'undeclared';
    findings.push({ level: 'signal', rule: 'undeclared-container', subjects: [u.id], message: `Unit ${u.path} is observed in the code, but no declared element has path '${u.path}'.`, evidence: u.evidence.slice(0, 1) });
  }

  // A relation endpoint without a path belongs to its nearest ancestor with one (a component inside
  // a container); with none, it is a system outside the repository.
  const endpoint = (id) => {
    for (let cur = id; cur; cur = byId.get(cur)?.parent) if (nodeOf.has(cur)) return nodeOf.get(cur);
    const e = byId.get(id);
    if (!e) return null;
    if (!systems.has(id)) systems.set(id, { id: `system:${id}`, kind: 'system', title: e.title, declared: declaredOf(e), evidence: [ev(id)] });
    return `system:${id}`;
  };
  const links = new Map();
  for (const l of model.links) {
    const s = endpoint(l.source), t = endpoint(l.target);
    if (!s || !t) {
      findings.push({ level: 'unknown', rule: 'declared-link-unresolved', subjects: [`${l.source}`, `${l.target}`], message: `Declared link ${l.source} -> ${l.target} names an element the model does not define.`, evidence: [ev(`${l.source} -> ${l.target}`)] });
      continue;
    }
    if (s === t) continue;
    const k = `${s}\u0000${t}`;
    if (!links.has(k)) links.set(k, { source: s, target: t, declared: [], evidence: [] });
    const x = links.get(k);
    x.declared.push({ ...(l.title ? { title: l.title } : {}), ...(l.technology ? { technology: l.technology } : {}) });
    x.evidence.push(ev(`${l.source} -> ${l.target}`));
  }
  return {
    nodes: [...systems.values()],
    findings,
    links: [...links.values()].map((l) => ({ ...l, declared: sortEvidence(l.declared), evidence: sortEvidence(l.evidence) })),
  };
}

// After linking: every declared link is confirmed by an observed depends-on edge or stays
// declared-unverified; every observed link between declared units that the model lacks is undeclared.
export function crossCheckLinks(snapshot, declaredLinks) {
  const findings = [];
  const nodes = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const observed = new Map(snapshot.edges.filter((e) => e.kind === 'depends-on').map((e) => [`${e.source}\u0000${e.target}`, e]));
  for (const l of declaredLinks) {
    const e = observed.get(`${l.source}\u0000${l.target}`);
    if (e) {
      Object.assign(e, { declared: l.declared, status: 'confirmed', evidence: sortEvidence([...e.evidence, ...l.evidence]) });
      continue;
    }
    snapshot.edges.push({ source: l.source, target: l.target, kind: 'depends-on', declared: l.declared, status: 'declared-unverified', evidence: l.evidence });
    findings.push({ level: 'unknown', rule: 'declared-unverified-link', subjects: [l.source, l.target], message: `Declared link ${l.source} -> ${l.target} has no static evidence in the code. Runtime links (HTTP, IPC, child processes) are not visible to static analysis.`, evidence: l.evidence });
  }
  for (const e of observed.values()) {
    if (e.status) continue;
    e.status = 'undeclared';
    if (nodes.get(e.source)?.declared && nodes.get(e.target)?.declared) {
      findings.push({ level: 'signal', rule: 'undeclared-link', subjects: [e.source, e.target], message: `The code links ${e.source} -> ${e.target}, but the declared model has no such relation.`, evidence: e.evidence.slice(0, 1) });
    }
  }
  return findings;
}
