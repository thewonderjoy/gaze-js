#!/usr/bin/env node
// `gaze-js run -- <command>`: runs a command with NODE_OPTIONS=--import <this package's auto entry>, so
// every Node process it starts (Next, Nuxt, Vite SSR, Nest, workers, child processes) reports, with no
// code changes. A file URL, so it works from any working directory and needs no quoting on Windows.
// While Gaze is off (GAZE_ENABLED=false, or NODE_ENV=production without GAZE_ENABLED=true) it runs the
// command as it is, without the import.
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { off } from './platform/node.js';

const args = process.argv.slice(2);
const cmd = args[0] == 'run' ? args.slice(args[1] == '--' ? 2 : 1) : [];
if (!cmd.length) {
  console.error('usage: gaze-js run -- <command> [args…]   e.g. gaze-js run -- npm run dev');
  process.exit(2);
}
const auto = pathToFileURL(fileURLToPath(new URL('./auto-node.js', import.meta.url))).href;
const env = off() ? process.env : { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${auto}`.trim() };
const child = spawn(cmd.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' '), { env, shell: true, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
