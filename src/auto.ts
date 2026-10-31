// Side-effect entry: `import '@thewonderjoy/gaze-js/auto'` installs console, error and network capture
// synchronously. Choose modules with globalThis.GAZE_CAPTURE (e.g. { console: false }) or, in Node,
// GAZE_CAPTURE=errors,network.
import { ray } from '@thewonderjoy/gaze-js';
import { install } from './capture.js';
import type { CaptureOptions } from './core/ray.js';

const G = globalThis as Record<string, any>;

function options(): CaptureOptions | undefined {
  const g = G.GAZE_CAPTURE;
  if (g && typeof g == 'object') return { console: g.console !== false, errors: g.errors !== false, network: g.network !== false };
  let env: string | undefined;
  try {
    if (!G.Deno) env = G.process?.env?.GAZE_CAPTURE;
  } catch {}
  if (!env) return undefined;
  const on = (k: string) => env!.split(/[\s,]+/).includes(k);
  return { console: on('console'), errors: on('errors'), network: on('network') };
}

/** Uninstalls the capture modules installed by this import. */
export const uninstall: () => void = install(ray, options());
