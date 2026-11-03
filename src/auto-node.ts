// `@thewonderjoy/gaze-js/auto` for Node, Bun and Deno: the browser-safe capture modules plus request
// traces and SQL. Also what `node --import @thewonderjoy/gaze-js/auto` and `gaze-js run` load. Through
// NODE_OPTIONS it also loads into package managers' own processes (npm, pnpm, yarn), which stay quiet.
// While Gaze is off (the package then exports the no-op) it installs nothing, and neither does it in a
// Jest test file.
import { ray } from '@thewonderjoy/gaze-js';
import { autoOptions, inJestFile } from './capture.js';
import { install } from './capture-node.js';

const main = String((globalThis as Record<string, any>).process?.argv?.[1] ?? '');
const tooling = /[\\/](?:npm|npx|pnpm|yarn|corepack)(?:[\\/]|\.c?js$)|[\\/]npm-(?:cli|prefix)\.js$/i.test(main);

/** Uninstalls the capture modules installed by this import. */
export const uninstall: () => void = tooling || inJestFile() || ray.disabled() ? () => {} : install(ray, autoOptions());
