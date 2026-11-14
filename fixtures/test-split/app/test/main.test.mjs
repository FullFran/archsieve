import { main } from '../src/main.mjs';
import { core } from '../../lib/src/core.mjs';
import { makeUser } from '../../lib/src/fixtures.mjs';
export const run = () => [main(), core(), makeUser()];
