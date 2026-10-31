// Bundle-size check (research note 03 §7.11 budgets). Bundles each target from source with rolldown,
// minifies with its oxc minifier, and reports min and min+gzip (zlib level 9) bytes. Dynamic imports
// (the capture module) are split off, so "core" is what `import { ray }` costs before ray.capture().
//   node scripts/size.mjs          print the table, exit 1 when a hard budget is exceeded
//   node scripts/size.mjs --json   machine-readable output
import { rolldown } from 'rolldown';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => join(root, 'src', p).replace(/\\/g, '/');
const tmp = mkdtempSync(join(tmpdir(), 'gaze-size-'));

/** [name, entry code, budget bytes (min+gz) or null, hard budget?] */
const targets = [
  ['core: browser entry (full API, serializer, transport)', `export { ray } from '${src('browser.ts')}';`, 5 * 1024, false],
  ['core + capture (console/errors/network)', `export { ray } from '${src('browser.ts')}'; export { install } from '${src('capture.ts')}';`, 9 * 1024, false],
  ['lazy chunk: Ray-compat encoder (wire: ray)', `export { rayEnvelope } from '${src('core/ray-wire.ts')}';`, null],
  ['IIFE equivalent (core + capture + encoder)', `export { ray } from '${src('browser.ts')}'; export { install } from '${src('capture.ts')}'; export { rayEnvelope } from '${src('core/ray-wire.ts')}';`, null],
  ['adapter: vue', `export * from '${src('adapters/vue.ts')}';`, 1536, true],
  ['adapter: react', `export * from '${src('adapters/react.ts')}';`, 1536, true],
  ['adapter: svelte', `export * from '${src('adapters/svelte.ts')}';`, 1536, true],
  ['noop', `export * from '${src('noop.ts')}';`, 512, true],
  ['  part: serializer', `export { serialize } from '${src('core/serialize.ts')}';`, null],
  ['  part: stack capture', `export { callerFrames } from '${src('core/stack.ts')}';`, null],
  ['  part: client/outbox (+ids)', `export { Client } from '${src('core/client.ts')}';`, null],
];

const results = [];
for (const [name, code, budget, hard] of targets) {
  const entry = join(tmp, 'entry.js');
  writeFileSync(entry, code);
  const bundle = await rolldown({
    input: entry,
    platform: 'browser',
    external: ['@thewonderjoy/gaze-js', 'vue', 'react', 'svelte'],
    logLevel: 'silent',
  });
  const { output } = await bundle.generate({ format: 'esm', minify: true });
  await bundle.close();
  // The entry plus every chunk it imports statically (shared chunks count; dynamic imports do not).
  const chunks = new Map(output.filter((o) => o.type == 'chunk').map((o) => [o.fileName, o]));
  const seen = new Set();
  const visit = (c) => {
    if (seen.has(c.fileName)) return;
    seen.add(c.fileName);
    for (const i of c.imports) if (chunks.has(i)) visit(chunks.get(i));
  };
  visit(output.find((o) => o.type == 'chunk' && o.isEntry));
  const bytes = Buffer.from([...seen].map((f) => chunks.get(f).code).join('\n'));
  const gz = gzipSync(bytes, { level: 9 }).length;
  results.push({ name, min: bytes.length, gzip: gz, budget, ok: budget == null || gz <= budget, hard: !!hard, chunks: output.length });
}
rmSync(tmp, { recursive: true, force: true });

if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('target', 58), pad('min', 8), pad('min+gz', 8), 'budget');
  for (const r of results)
    console.log(pad(r.name, 58), pad(r.min, 8), pad(r.gzip, 8), r.budget == null ? '' : `${r.budget} ${r.ok ? 'ok' : r.hard ? 'OVER' : 'over (soft)'}`);
}
if (results.some((r) => r.hard && !r.ok)) process.exit(1);
