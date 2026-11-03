// Builds (all ESM, .js, no hashes in entry names):
//   dist/node.js     node/bun/deno condition (node: imports allowed)
//   dist/browser.js  browser/default condition
//   dist/edge.js     workerd/edge-light condition (no node: imports)
//   dist/{auto,noop,vite}.js, dist/adapters/{vue,react,svelte}.js
//   dist/gaze.global.js  IIFE (minified), sets globalThis.ray only if undefined
//   dist/cjs/*.cjs   CommonJS copies of node, browser, auto-node, auto, noop and the adapters, for
//                    loaders that cannot require() an ES module (Jest). package.json lists them under
//                    `require` after `module-sync`, which Node 20.19+ always matches, so Node itself
//                    keeps loading the ESM files.
// Declarations come from `tsc -p tsconfig.build.json` (dist/types). auto.js and the adapters import
// "@thewonderjoy/gaze-js" itself, so they share the instance the export conditions pick.
// `process.env.NODE_ENV` stays as written: the app's bundler fills it in (a production build gets the
// no-op), so the browser builds must not bake in rolldown's "development".
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
  define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
};
const cjs: UserConfig = { ...base, format: 'cjs', outDir: 'dist/cjs' };
const shared = {
  auto: 'src/auto.ts',
  noop: 'src/noop.ts',
  'adapters/vue': 'src/adapters/vue.ts',
  'adapters/react': 'src/adapters/react.ts',
  'adapters/svelte': 'src/adapters/svelte.ts',
};

export default defineConfig([
  { ...base, entry: { node: 'src/node.ts', 'auto-node': 'src/auto-node.ts', bin: 'src/bin.ts' }, platform: 'node', target: 'node20', outputOptions: { chunkFileNames: 'node-[name]-[hash].js' } },
  { ...base, entry: { browser: 'src/browser.ts' }, platform: 'browser', target: 'es2022', outputOptions: { chunkFileNames: 'browser-[name]-[hash].js' } },
  { ...base, entry: { edge: 'src/edge.ts' }, platform: 'neutral', target: 'es2022', outputOptions: { chunkFileNames: 'edge-[name]-[hash].js' } },
  { ...base, entry: shared, platform: 'neutral', target: 'es2022', outputOptions: { chunkFileNames: 'shared-[name]-[hash].js' } },
  // `exports: 'named'`: `exports.default` next to the named exports, with `__esModule`, as tsc's and
  // Babel's interop expect.
  { ...cjs, entry: { node: 'src/node.ts', 'auto-node': 'src/auto-node.ts' }, platform: 'node', target: 'node20', outputOptions: { exports: 'named', chunkFileNames: 'node-[name]-[hash].cjs' } },
  { ...cjs, entry: { browser: 'src/browser.ts' }, platform: 'browser', target: 'es2022', outputOptions: { exports: 'named', chunkFileNames: 'browser-[name]-[hash].cjs' } },
  { ...cjs, entry: shared, platform: 'neutral', target: 'es2022', outputOptions: { exports: 'named', chunkFileNames: 'shared-[name]-[hash].cjs' } },
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
