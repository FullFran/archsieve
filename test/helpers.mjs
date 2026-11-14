import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BIN = join(ROOT, 'bin', 'archsieve.mjs');
export const fixture = (...p) => join(ROOT, 'fixtures', ...p);

export function cli(args, { env } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: env ?? process.env });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'archsieve-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

// Nest fixtures must be compiled (emitDecoratorMetadata) before the DI graph can be read.
export function compileNestFixtures() {
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  for (const s of ['before', 'after']) {
    const r = spawnSync(process.execPath, [tsc, '-p', fixture('nest-shop', s)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tsc failed for ${s}: ${r.stdout}${r.stderr}`);
  }
}
