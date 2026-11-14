import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';

// tsconfig files are read as data: TypeScript's own JSONC reader parses them (comments, trailing
// commas), relative `extends` chains are followed, and nothing is executed. Used only to explain
// unresolved imports that a `compilerOptions.paths` alias would resolve.

let ts = null;
const typescript = () => (ts ??= createRequire(import.meta.url)('typescript'));

function readConfig(root, file, seen = new Set()) {
  if (seen.has(file) || seen.size > 8) return null;
  seen.add(file);
  let text;
  try { text = readFileSync(join(root, file), 'utf8'); } catch { return null; }
  let config;
  // Plain JSON first; TypeScript's JSONC reader (about 150 ms to load) only for comments or trailing commas.
  try { config = JSON.parse(text); } catch { ({ config } = typescript().parseConfigFileTextToJson(file, text)); }
  if (!config || typeof config !== 'object') return null;
  let paths = {};
  const parents = [config.extends ?? []].flat().filter((p) => typeof p === 'string' && p.startsWith('.'));
  for (const p of parents) {
    const rel = posix.normalize(posix.join(posix.dirname(file), p.endsWith('.json') ? p : `${p}.json`));
    paths = { ...paths, ...(readConfig(root, rel, seen)?.paths ?? {}) };
  }
  return { paths: { ...paths, ...(config.compilerOptions?.paths ?? {}) } };
}

// '@/*' matches '@/lib/util'; a key without '*' matches only itself.
const keyMatches = (key, spec) => {
  const star = key.indexOf('*');
  if (star < 0) return key === spec;
  const pre = key.slice(0, star), post = key.slice(star + 1);
  return spec.length >= pre.length + post.length && spec.startsWith(pre) && spec.endsWith(post);
};

// One hint per tsconfig whose paths match at least one unresolved import specifier.
export function tsConfigHints(root, files, unresolved) {
  if (!files.length || !unresolved.length) return [];
  const hints = [];
  for (const file of files) {
    const keys = Object.keys(readConfig(root, file)?.paths ?? {}).sort();
    if (!keys.length) continue;
    const hits = unresolved.flatMap((f) => f.evidence).filter((e) => e.detail && keys.some((k) => keyMatches(k, e.detail)));
    if (!hits.length) continue;
    const used = keys.filter((k) => hits.some((e) => keyMatches(k, e.detail)));
    const importers = [...new Set(hits.map((e) => e.file))].sort();
    hints.push({
      file,
      count: hits.length,
      finding: {
        level: 'signal', rule: 'ts-config-hint', subjects: [file],
        message: `${hits.length} unresolved import${hits.length > 1 ? 's' : ''} match compilerOptions.paths ${used.map((k) => `"${k}"`).join(', ')} in ${file}; rescan with --ts-config ${file} (or --ts-config auto).`,
        evidence: [...importers.slice(0, 5).map((f) => ({ tool: 'tsconfig', file: f })), { tool: 'tsconfig', file }].sort((a, b) => (a.file < b.file ? -1 : 1)),
      },
    });
  }
  return hints;
}
