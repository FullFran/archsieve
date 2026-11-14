import { relative, join } from 'node:path';
import { run, cycles } from '../util.mjs';

// Uses the official Go toolchain (`go list`). Network and module downloads are disabled:
// if dependencies are not already in the module cache, packages are reported as unknown.
const SAFE_ENV = { ...process.env, GOFLAGS: '-mod=readonly', GOPROXY: 'off', GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOWORK: 'off' };
const FMT = '{{.ImportPath}}\t{{.Dir}}\t{{.Standard}}\t{{join .Imports ","}}\t{{.Name}}\t{{if .Error}}{{.Error.Err}}{{end}}';

export function goVersion() {
  return run('go', ['env', 'GOVERSION'], { env: SAFE_ENV }).stdout.trim();
}

export function scanGo(root, moduleDir) {
  const dir = join(root, moduleDir);
  const modPath = run('go', ['list', '-m', '-f', '{{.Path}}'], { cwd: dir, env: SAFE_ENV }).stdout.trim();
  const res = run('go', ['list', '-e', '-f', FMT, './...'], { cwd: dir, env: SAFE_ENV });
  const tool = 'go list';
  const nodes = new Map(), edges = [], findings = [], mains = [];
  const id = (p) => `go:${p}`;
  for (const line of res.stdout.split('\n').filter(Boolean)) {
    const [path, pkgDir, , imports, name, error] = line.split('\t');
    const file = relative(root, pkgDir).split('\\').join('/') || '.';
    if (name === 'main') mains.push({ dir: file, importPath: path });
    nodes.set(id(path), { id: id(path), kind: 'go-package', file, evidence: [{ tool, file }] });
    if (error) findings.push({ level: 'unknown', rule: 'go-package-error', subjects: [id(path)], message: `go list could not fully load ${path}: ${error.slice(0, 200)}`, evidence: [{ tool, file }] });
    for (const imp of (imports || '').split(',').filter(Boolean)) {
      const internal = imp === modPath || imp.startsWith(`${modPath}/`);
      const firstSeg = imp.split('/')[0];
      if (!internal && !firstSeg.includes('.')) continue; // standard library
      let target = id(imp);
      if (!internal) {
        // collapse external packages to their probable module root (host/org/repo)
        target = `go:${imp.split('/').slice(0, 3).join('/')}`;
        if (!nodes.has(target)) nodes.set(target, { id: target, kind: 'external-package', evidence: [{ tool }] });
      }
      edges.push({ source: id(path), target, kind: 'imports', evidence: [{ tool, file }] });
    }
  }
  // Go forbids import cycles at compile time; a cycle here means the code does not build.
  for (const comp of cycles(edges)) findings.push({ level: 'error', rule: 'no-circular', subjects: comp, message: `Go import cycle among ${comp.join(', ')}`, evidence: [{ tool }] });
  return { nodes: [...nodes.values()], edges, findings, module: modPath, mains };
}
