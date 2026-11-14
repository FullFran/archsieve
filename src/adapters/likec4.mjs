import { readFileSync } from 'node:fs';

// Reads the JSON that `likec4 export json --skip-layout` writes and translates it into ArchSieve's
// neutral declared model. LikeC4 itself is never required or run: the export is plain data.
//
// Neutral model: { elements: [{ id, title, technology?, path?, parent? }], links: [{ source, target, title?, technology? }] }
// `path` comes from the standard LikeC4 element metadata `metadata { path '<dir>' }`.
export function readLikeC4(file) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw badInput(`cannot read declared model ${file}: ${e.message}`);
  }
  if (!doc || typeof doc.elements !== 'object' || typeof doc.relations !== 'object' || doc.elements === null || doc.relations === null) {
    throw badInput(`${file} is not a LikeC4 JSON export (expected "elements" and "relations"; run \`likec4 export json --skip-layout\`)`);
  }
  const ids = new Set(Object.keys(doc.elements));
  const parentOf = (id) => {
    for (let i = id.lastIndexOf('.'); i > 0; i = id.lastIndexOf('.', i - 1)) {
      const p = id.slice(0, i);
      if (ids.has(p)) return p;
    }
    return undefined;
  };
  const elements = Object.values(doc.elements).map((e) => ({
    id: e.id,
    title: e.title ?? e.id,
    ...(e.technology ? { technology: e.technology } : {}),
    ...(e.metadata?.path !== undefined ? { path: e.metadata.path } : {}),
    ...(parentOf(e.id) ? { parent: parentOf(e.id) } : {}),
  }));
  const links = Object.values(doc.relations).map((r) => ({
    source: r.source?.model,
    target: r.target?.model,
    ...(r.title ? { title: r.title } : {}),
    ...(r.technology ? { technology: r.technology } : {}),
  }));
  return { format: 'likec4', elements, links };
}

function badInput(message) {
  const err = new Error(message);
  err.code = 'BAD_INPUT';
  return err;
}
