// Capture modules for Node, Bun and Deno: the browser-safe ones plus request traces and SQL, kept in
// their own chunk so the browser bundle does not grow.
import { install as base } from './capture.js';
import type { CaptureOptions, RayFn } from './core/ray.js';
import { captureRequests } from './node/requests.js';
import { captureQueries } from './node/sql.js';

/** Install the selected capture modules (all of them when `options` is omitted). */
export function install(ray: RayFn, o?: CaptureOptions): () => void {
  // Installed once per process: a bundled copy and an --import copy must not both report.
  const G = globalThis as Record<symbol, unknown>;
  const K = Symbol.for('gaze.capture');
  if (G[K]) return () => {};
  G[K] = true;
  const undo: (() => void)[] = [base(ray, o)];
  const ctx = ray.$client.p.ctx;
  if (!o || o.queries) undo.push(captureQueries(ray, ctx).undo);
  if (!o || o.requests) undo.push(captureRequests(ray, ctx));
  return () => {
    undo.forEach((f) => f());
    G[K] = false;
  };
}
