// Runs the API and the Vite dev server together; Ctrl+C stops both.
import { spawn } from 'node:child_process';

const children = ['server', 'web'].map((workspace) =>
  spawn('npm', ['run', 'dev', '-w', workspace], { stdio: 'inherit' }),
);

const stop = () => children.forEach((child) => child.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', stop);
