// Entry for the `node` export condition of "@thewonderjoy/gaze-js". Off (GAZE_ENABLED=false, or
// NODE_ENV=production without GAZE_ENABLED=true) it exports the no-op: no client is created and
// nothing is patched, so configure() or enable() cannot switch it on later.
import { createRay, type RayFn } from './core/ray.js';
import { ray as noop } from './noop.js';
import { node, off } from './platform/node.js';

/** `ray(...values)`: dump values to Gaze. Chainable; see README for the full API. */
export const ray: RayFn = off()
  ? noop
  : createRay(node, {
      capture: () => import('./capture-node.js'),
      ray: () => import('./core/ray-wire.js').then((m) => m.rayEnvelope),
    });
/** Alias of `ray`. */
export const gaze = ray;
/** Alias of `ray`. */
export const dump = ray;
export default ray;
export * from './core/public.js';
