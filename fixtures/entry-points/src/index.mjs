import { spawn } from 'node:child_process';

export function startJob() {
  return spawn(process.execPath, ['jobs/child.mjs']);
}
