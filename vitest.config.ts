import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const self = fileURLToPath(new URL('./src/node.ts', import.meta.url));

export default defineConfig({
  resolve: {
    // The adapters and ./auto import the package itself; in tests that is the Node entry from source.
    alias: [{ find: /^@thewonderjoy\/gaze-js$/, replacement: self }],
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/e2e/**'], environment: 'node' },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/e2e/setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
