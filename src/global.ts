// IIFE build (dist/gaze.global.js) for pages without a bundler, e.g. served by the Laravel package.
// Sets globalThis.ray / gaze / dump only where they are still undefined, so it never shadows another
// helper. Optional config on the script tag: data-host, data-port, data-wire, data-project, data-capture.
import { ray } from './browser.js';
import type { CaptureOptions, Wire } from './browser.js';

const G = globalThis as Record<string, any>;
for (const k of ['ray', 'gaze', 'dump']) if (G[k] === undefined) G[k] = ray;
G.Gaze = { ray, gaze: ray, dump: ray };

const d = (G.document?.currentScript as HTMLScriptElement | null)?.dataset;
if (d) {
  ray.configure({
    host: d.host || undefined,
    port: d.port ? +d.port : undefined,
    wire: (d.wire as Wire) || undefined,
    project: d.project || undefined,
  });
  if (d.capture != null) {
    const on = (k: string) => d.capture == '' || d.capture!.split(/[\s,]+/).includes(k);
    const o: CaptureOptions = { console: on('console'), errors: on('errors'), network: on('network') };
    void ray.capture(o);
  }
}
