// What every entry exports while Gaze is off, and the production alias (the `production` export
// condition and the Vite plugin point the package and ./auto here in builds). One Proxy stands in for
// the function and every chained Ray, so bundles carry a few hundred bytes and no transport,
// serializer or capture code. Calls that wrap the app's own code still run it: group() returns its
// result, measure(fn) calls fn, pass() returns its value.
import type { RateLimiter as RL, Ray as R, RayFn, StopExecutionRequested as SER } from './core/ray.js';

const ASYNC = new Set(['flush', 'pause', 'die', 'capture']);
const n: any = new Proxy(function () {}, {
  get(_t, k) {
    if (typeof k == 'symbol' || k == 'then') return undefined;
    if (k == 'pass') return (v: unknown) => v;
    if (k == 'group') return (_label: unknown, fn: () => unknown) => fn();
    if (k == 'measure') return (f: unknown) => (run(f), n);
    if (ASYNC.has(k)) return () => Promise.resolve(k == 'capture' ? () => {} : k == 'pause' ? 'released' : undefined);
    if (k == 'counterValue') return () => 0;
    if (k == 'enabled') return () => false;
    if (k == 'disabled') return () => true;
    if (k == 'id') return '';
    return n;
  },
  apply: () => n,
});

/** measure(fn) runs fn as it does while enabled, a rejection of what it returns included (not reported). */
function run(f: unknown): void {
  if (typeof f != 'function') return;
  const r = f();
  if (r && typeof r.then == 'function') r.then(off, off);
}
const off = (): void => {};

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
/** Never thrown here: pause() resolves 'released'. */
export const StopExecutionRequested = class extends Error {} as unknown as typeof SER;
export type StopExecutionRequested = SER;
/** Stand-in for "@thewonderjoy/gaze-js/auto". */
export const uninstall = (): void => {};
export type { CaptureOptions, Color, LockState, Options, Origin, RayFn, Size, Value, WatchOptions } from './core/ray.js';
