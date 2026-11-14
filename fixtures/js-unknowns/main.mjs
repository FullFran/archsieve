import { helper } from './helper.mjs';
import { generated } from './codegen/client.mjs';

export async function load(name) {
  const plugin = await import(`./plugins/${name}.mjs`);
  return [helper(), generated, plugin];
}
