// Runs INSIDE the target project (cwd = target). Loads the target's own @nestjs/core.
// preview: true  -> providers/controllers are NOT instantiated (no constructors, no lifecycle hooks).
// snapshot: true -> the official SerializedGraph is recorded.
// Module top-level code still runs on require(): only use on code you trust.
const path = require('node:path');
const { createRequire } = require('node:module');
const [entryArg, exportName = 'AppModule'] = process.argv.slice(2);
const entry = path.resolve(entryArg);
const r = createRequire(entry);
r('reflect-metadata');
const { NestFactory } = r('@nestjs/core');
const { SerializedGraph } = r('@nestjs/core/inspector/serialized-graph');
(async () => {
  const mod = r(entry)[exportName];
  if (!mod) throw new Error(`export ${exportName} not found in ${entryArg}`);
  const app = await NestFactory.createApplicationContext(mod, { snapshot: true, preview: true, logger: false, abortOnError: false });
  const graph = app.get(SerializedGraph).toJSON();
  const version = r('@nestjs/core/package.json').version;
  process.stdout.write(JSON.stringify({ version, graph }));
  await app.close();
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(2); });
