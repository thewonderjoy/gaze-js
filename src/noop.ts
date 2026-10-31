// Production alias: same exports, every call is a no-op (the Vite plugin aliases the package and
// ./auto here in builds). One Proxy stands in for the function and every chained Ray, so bundles
// carry a few hundred bytes and no transport, serializer or capture code.
import type { RateLimiter as RL, Ray as R, RayFn } from './core/ray.js';

const ASYNC = new Set(['flush', 'pause', 'die', 'capture']);
const n: any = new Proxy(function () {}, {
  get(_t, k) {
    if (typeof k == 'symbol' || k == 'then') return undefined;
    if (k == 'pass') return (v: unknown) => v;
    if (ASYNC.has(k)) return () => Promise.resolve(k == 'capture' ? () => {} : k == 'pause' ? 'released' : undefined);
    if (k == 'counterValue') return () => 0;
    if (k == 'enabled') return () => false;
    if (k == 'disabled') return () => true;
    if (k == 'id') return '';
    return n;
  },
  apply: () => n,
});

export const ray: RayFn = n;
export const gaze: RayFn = n;
export const dump: RayFn = n;
export default ray;
export const VERSION = 'noop';
/** Value exports of the real entry, so `import { Ray } from …` keeps resolving in production. */
export const Ray = class {} as unknown as typeof R;
export type Ray = R;
export const RateLimiter = class {} as unknown as typeof RL;
export type RateLimiter = RL;
/** Stand-in for "@thewonderjoy/gaze-js/auto". */
export const uninstall = (): void => {};
export type { CaptureOptions, Color, LockState, Options, Origin, RayFn, Size, Value, WatchOptions } from './core/ray.js';
