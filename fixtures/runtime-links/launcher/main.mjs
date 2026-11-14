import { spawn, execFile } from 'node:child_process';
const WORKER = 'worker/index.mjs';
spawn('node', [WORKER], { stdio: 'pipe' });
execFile('svc-bin', ['--port', '1']);
spawn('git', ['status']);
spawn(process.env.LAUNCH_CMD);
