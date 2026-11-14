// Resolves to node_modules/ajv/dist/2020.js: a "dist" path inside a package must not be excluded.
import Ajv2020 from 'ajv/dist/2020.js';

export const ajv = new Ajv2020();
