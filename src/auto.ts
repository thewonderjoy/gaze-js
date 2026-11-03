// Side-effect entry: `import '@thewonderjoy/gaze-js/auto'` installs console, error and network capture
// synchronously. Choose modules with globalThis.GAZE_CAPTURE (e.g. { console: false }) or, in Node,
// GAZE_CAPTURE=errors,network. Node, Bun and Deno load auto-node.ts instead, which adds request traces
// and SQL. While Gaze is off it installs nothing (a production build resolves ./auto to the no-op), and
// neither does it in a Jest test file.
import { ray } from '@thewonderjoy/gaze-js';
import { autoOptions, inJestFile, install } from './capture.js';

/** Uninstalls the capture modules installed by this import. */
export const uninstall: () => void = ray.disabled() || inJestFile() ? () => {} : install(ray, autoOptions());
