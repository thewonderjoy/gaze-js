// e2e global setup: build the headless core (gaze-serve) and this package's dist/ once.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repo = fileURLToPath(new URL('../../../../', import.meta.url));
export const pkg = fileURLToPath(new URL('../../', import.meta.url));

export default function setup(): void {
  execFileSync('cargo', ['build', '-p', 'gaze-core', '--bin', 'gaze-serve'], { cwd: repo, stdio: 'inherit' });
  execFileSync(process.execPath, [pkg + 'node_modules/tsdown/dist/run.mjs', '--log-level', 'warn'], { cwd: pkg, stdio: 'inherit' });
}
