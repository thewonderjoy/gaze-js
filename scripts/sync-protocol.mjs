// Copies the generated protocol types (protocol/generated/batch.d.ts) into src/generated/batch.ts.
// A .ts copy (not .d.ts) is needed so `tsc` emits it next to our own declarations; the published
// package must not reference files outside its own directory. test/protocol-sync.test.ts fails
// when the copy drifts from the source.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const source = join(here, '..', '..', '..', 'protocol', 'generated', 'batch.d.ts');
export const target = join(here, '..', 'src', 'generated', 'batch.ts');
export const header = '// Copy of protocol/generated/batch.d.ts. Do not edit; run `pnpm sync-protocol`.\n';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, header + readFileSync(source, 'utf8'));
  console.log(`wrote ${target}`);
}
