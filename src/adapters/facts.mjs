import { readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { byKey } from '../util.mjs';

// Facts per container, never a score (ADR 0003): files and lines per language, manifests with their
// declared dependency counts, and the toolchains a maintainer needs, each with the file that implies
// it. Files are the scan's tracked (or, outside git, walked) files; nothing is downloaded or run.

// Larger files (assets, generated bundles) count as files without lines, so they are never read whole.
const MAX_READ = 4 * 1024 * 1024;

const LANGUAGE_BY_EXT = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  go: 'go', rs: 'rust', py: 'python', rb: 'ruby', php: 'php', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', scala: 'scala',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', sh: 'shell', bash: 'shell', zsh: 'shell',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', ini: 'ini',
  md: 'markdown', mdx: 'markdown', css: 'css', scss: 'css', sass: 'css', less: 'css', html: 'html', htm: 'html',
  c4: 'likec4', likec4: 'likec4', vue: 'vue', svelte: 'svelte', sql: 'sql', proto: 'protobuf', graphql: 'graphql', gql: 'graphql', dockerfile: 'dockerfile',
};
const LANGUAGE_BY_NAME = { 'go.mod': 'go', 'go.work': 'go', Makefile: 'make', Dockerfile: 'dockerfile' };

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'go.sum', 'go.work.sum', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock']);
const MANIFESTS = new Set(['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts']);

// A toolchain and the first file (in path order) that implies it.
const TOOLCHAINS = [
  ['node', (b) => b === 'package.json'],
  ['go', (b) => b === 'go.mod' || b === 'go.work'],
  ['rust', (b) => b === 'Cargo.toml' || /^rust-toolchain(\.toml)?$/.test(b)],
  ['tauri', (b) => b === 'tauri.conf.json'],
  ['python', (b) => ['pyproject.toml', 'setup.py', 'Pipfile'].includes(b) || /^requirements.*\.txt$/.test(b) || b.endsWith('.py')],
  ['docker', (b) => /^Dockerfile/.test(b) || b.endsWith('.dockerfile') || /^(docker-)?compose.*\.ya?ml$/.test(b)],
  ['powershell', (b) => /\.ps(m|d)?1$/.test(b)],
  ['shell', (b) => /\.(sh|bash|zsh)$/.test(b)],
  ['make', (b) => b === 'Makefile'],
  ['java', (b) => ['pom.xml', 'build.gradle', 'build.gradle.kts'].includes(b)],
  ['dotnet', (b) => /\.(csproj|fsproj|sln)$/.test(b)],
  ['ruby', (b) => b === 'Gemfile'],
  ['php', (b) => b === 'composer.json'],
];

export function languageOf(file) {
  const base = posix.basename(file);
  if (LANGUAGE_BY_NAME[base]) return LANGUAGE_BY_NAME[base];
  if (/^Dockerfile/.test(base)) return 'dockerfile';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return LANGUAGE_BY_EXT[ext] ?? 'other';
}

// Lines in a text file; null for binary content (a NUL byte in the first 8 KB).
function countLines(buf) {
  if (buf.subarray(0, 8192).includes(0)) return null;
  let n = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
  return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
}

// Declared dependency counts, read as data. Absent fields mean "not counted", never zero.
function dependencyCounts(base, text) {
  if (base === 'package.json') {
    const pkg = JSON.parse(text);
    const n = (...fields) => fields.reduce((s, f) => s + Object.keys(pkg[f] ?? {}).length, 0);
    return { dependencies: n('dependencies', 'optionalDependencies', 'peerDependencies'), devDependencies: n('devDependencies') };
  }
  if (base === 'go.mod') {
    const reqs = [];
    let block = false;
    for (const line of text.split('\n').map((l) => l.trim())) {
      if (/^require\s*\($/.test(line)) { block = true; continue; }
      if (block && line === ')') { block = false; continue; }
      if (block && line && !line.startsWith('//')) reqs.push(line);
      else if (/^require\s+[^(]/.test(line)) reqs.push(line.replace(/^require\s+/, ''));
    }
    const indirect = reqs.filter((r) => /\/\/\s*indirect\b/.test(r)).length;
    return { dependencies: reqs.length - indirect, indirect };
  }
  if (base === 'Cargo.toml') {
    const count = { dependencies: 0, devDependencies: 0 };
    let section = null;
    for (const line of text.split('\n').map((l) => l.trim())) {
      const h = /^\[([^\]]+)\]$/.exec(line);
      if (h) { section = /(^|\.)(dev|build)-dependencies$/.test(h[1]) ? 'devDependencies' : /(^|\.)dependencies$/.test(h[1]) ? 'dependencies' : null; continue; }
      if (section && /^[\w-]+(\.\w+)?\s*=/.test(line)) count[section]++;
    }
    return count;
  }
  if (base === 'requirements.txt') return { dependencies: text.split('\n').filter((l) => l.trim() && !/^\s*(#|-)/.test(l)).length };
  return {};
}

export function containerFacts(root, units, files) {
  const deepest = [...units].sort(byKey((u) => String(1e6 - u.path.length).padStart(7, '0') + u.path));
  const within = (file, dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`);
  const facts = new Map(units.map((u) => [u.id, { files: 0, lines: 0, languages: {}, manifests: [], toolchains: new Map() }]));
  let outside = 0, unreadable = 0;
  for (const file of files) {
    const u = deepest.find((x) => within(file, x.path));
    if (!u) { outside++; continue; }
    const f = facts.get(u.id), base = posix.basename(file);
    for (const [name, test] of TOOLCHAINS) if (test(base) && !f.toolchains.has(name)) f.toolchains.set(name, file);
    if (LOCKFILES.has(base)) { f.manifests.push({ file, kind: 'lockfile' }); continue; }
    let buf;
    try { buf = statSync(join(root, file)).size > MAX_READ ? null : readFileSync(join(root, file)); } catch { unreadable++; continue; }
    if (MANIFESTS.has(base) && buf) {
      let counts = {};
      try { counts = dependencyCounts(base, buf.toString('utf8')); } catch { /* unparsable: counts unknown */ }
      f.manifests.push({ file, kind: base, ...counts });
    }
    const lines = buf ? countLines(buf) : null;
    const lang = languageOf(file);
    const l = (f.languages[lang] ??= { files: 0, lines: 0 });
    l.files++;
    f.files++;
    if (lines !== null) { l.lines += lines; f.lines += lines; }
  }
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  const out = new Map([...facts].map(([id, f]) => [id, {
    files: f.files, lines: f.lines, languages: sortObj(f.languages),
    manifests: f.manifests.sort(byKey((m) => m.file)),
    toolchains: [...f.toolchains].map(([name, file]) => ({ name, file })).sort(byKey((t) => t.name)),
  }]));
  return { facts: out, outside, unreadable };
}
