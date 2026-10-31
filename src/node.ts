// Entry for the `node` export condition of "@thewonderjoy/gaze-js".
import { createRay } from './core/ray.js';
import { node } from './platform/node.js';

/** `ray(...values)`: dump values to Gaze. Chainable; see README for the full API. */
export const ray = createRay(node, {
  capture: () => import('./capture.js'),
  ray: () => import('./core/ray-wire.js').then((m) => m.rayEnvelope),
});
/** Alias of `ray`. */
export const gaze = ray;
/** Alias of `ray`. */
export const dump = ray;
export default ray;
export * from './core/public.js';
