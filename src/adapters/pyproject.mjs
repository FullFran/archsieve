import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseToml } from './toml.mjs';

// What a pyproject.toml says, read as data: PEP 621 `[project]`, uv (`[tool.uv]`, PEP 735
// `[dependency-groups]`) and poetry (`[tool.poetry]`). Returns null when the file declares no
// project (tool configuration only, or a virtual uv workspace root): that is not a unit.
const DEV_EXTRAS = /^(dev|develop|development|test|tests|testing|lint|docs?|typing|ci)$/i;

export function pyprojectInfo(text) {
  const doc = parseToml(text);
  const project = doc.project, poetry = doc.tool?.poetry;
  if (!project && !poetry) return null;
  const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string').length : 0);
  let dependencies = strings(project?.dependencies), devDependencies = 0;
  for (const [group, deps] of Object.entries(project?.['optional-dependencies'] ?? {})) {
    if (DEV_EXTRAS.test(group)) devDependencies += strings(deps); else dependencies += strings(deps);
  }
  for (const deps of Object.values(doc['dependency-groups'] ?? {})) devDependencies += strings(deps);
  devDependencies += strings(doc.tool?.uv?.['dev-dependencies']);
  if (poetry) {
    const named = (t) => Object.keys(t ?? {}).filter((k) => k !== 'python').length;
    dependencies += named(poetry.dependencies);
    devDependencies += named(poetry['dev-dependencies']);
    for (const g of Object.values(poetry.group ?? {})) devDependencies += named(g?.dependencies);
  }
  const scriptsAt = project?.scripts ? 'project.scripts' : project?.['gui-scripts'] ? 'project.gui-scripts' : poetry?.scripts ? 'tool.poetry.scripts' : null;
  return { name: project?.name ?? poetry?.name ?? null, scriptsAt, dependencies, devDependencies };
}

// Why a Python unit can run, when it can: a declared script, a Dockerfile CMD/ENTRYPOINT next to the
// manifest, or a `__main__.py` in the unit (at its root, under src/ or in a package directory).
export function pythonRunnable(root, dir, info) {
  if (info.scriptsAt) return info.scriptsAt;
  const abs = (p) => join(root, dir, p);
  try {
    const docker = readFileSync(abs('Dockerfile'), 'utf8');
    const m = /^\s*(CMD|ENTRYPOINT)\b/m.exec(docker);
    if (m) return `Dockerfile ${m[1]}`;
  } catch { /* no Dockerfile */ }
  const dirs = (p) => { try { return readdirSync(abs(p), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => (p ? `${p}/${e.name}` : e.name)); } catch { return []; } };
  const candidates = ['', ...dirs(''), ...dirs('src')];
  return candidates.some((p) => existsSync(abs(p ? `${p}/__main__.py` : '__main__.py'))) ? '__main__.py' : null;
}
