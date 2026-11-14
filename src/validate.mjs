import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../schema/${f}`, import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(load('snapshot.schema.json'));
ajv.addSchema(load('diff.schema.json'));

export function validate(doc) {
  const id = doc?.kind === 'archsieve-diff' ? 'https://github.com/FullFran/archsieve/schema/diff-0.1.json' : 'https://github.com/FullFran/archsieve/schema/snapshot-0.1.json';
  const v = ajv.getSchema(id);
  return v(doc) ? [] : v.errors.map((e) => `${e.instancePath || '/'} ${e.message}`);
}
