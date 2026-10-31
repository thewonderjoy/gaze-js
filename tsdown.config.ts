// Builds (all ESM, .js, no hashes in entry names):
//   dist/node.js     node/bun/deno condition (node: imports allowed)
//   dist/browser.js  browser/default condition
//   dist/edge.js     workerd/edge-light condition (no node: imports)
//   dist/{auto,noop,vite}.js, dist/adapters/{vue,react,svelte}.js
//   dist/gaze.global.js  IIFE (minified), sets globalThis.ray only if undefined
// Declarations come from `tsc -p tsconfig.build.json` (dist/types). auto.js and the adapters import
// "@thewonderjoy/gaze-js" itself, so they share the instance the export conditions pick.
import { defineConfig, type UserConfig } from 'tsdown';

const self = ['@thewonderjoy/gaze-js', 'vue', 'react', 'svelte', 'vite'];
const base: UserConfig = {
  outDir: 'dist',
  format: 'esm',
  clean: false,
  dts: false,
  hash: true,
  fixedExtension: false,
  treeshake: true,
  sourcemap: false,
  deps: { neverBundle: self },
  // The bundler must not follow tsconfig `paths` (they point the self-import at src/ for type checks).
  tsconfig: 'tsconfig.bundle.json',
};

export default defineConfig([
  { ...base, entry: { node: 'src/node.ts' }, platform: 'node', target: 'node20', outputOptions: { chunkFileNames: 'node-[name]-[hash].js' } },
  { ...base, entry: { browser: 'src/browser.ts' }, platform: 'browser', target: 'es2022', outputOptions: { chunkFileNames: 'browser-[name]-[hash].js' } },
  { ...base, entry: { edge: 'src/edge.ts' }, platform: 'neutral', target: 'es2022', outputOptions: { chunkFileNames: 'edge-[name]-[hash].js' } },
  {
    ...base,
    entry: {
      auto: 'src/auto.ts',
      noop: 'src/noop.ts',
      'adapters/vue': 'src/adapters/vue.ts',
      'adapters/react': 'src/adapters/react.ts',
      'adapters/svelte': 'src/adapters/svelte.ts',
    },
    platform: 'neutral',
    target: 'es2022',
    outputOptions: { chunkFileNames: 'shared-[name]-[hash].js' },
  },
  { ...base, entry: { vite: 'src/vite.ts' }, platform: 'node', target: 'node20', outputOptions: { chunkFileNames: 'vite-[name]-[hash].js' } },
  {
    ...base,
    entry: { 'gaze.global': 'src/global.ts' },
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    outputOptions: { codeSplitting: false, entryFileNames: '[name].js' },
  },
]);
