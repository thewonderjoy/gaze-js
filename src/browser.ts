// Entry for the `browser` export condition of "@thewonderjoy/gaze-js". A production build gets the
// no-op (bundlers that apply the `production` export condition never include this file at all).
import { productionBuild } from './core/client.js';
import { createRay, type RayFn } from './core/ray.js';
import { ray as noop } from './noop.js';
import { browser } from './platform/browser.js';

/** `ray(...values)`: dump values to Gaze. Chainable; see README for the full API. */
export const ray: RayFn = productionBuild()
  ? noop
  : createRay(browser, {
      capture: () => import('./capture.js'),
      ray: () => import('./core/ray-wire.js').then((m) => m.rayEnvelope),
    });
/** Alias of `ray`. */
export const gaze = ray;
/** Alias of `ray`. */
export const dump = ray;
export default ray;
export * from './core/public.js';
