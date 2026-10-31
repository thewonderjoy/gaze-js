// Svelte 5 adapter. `$inspect(x).with(rayInspect)` (dev-only; a no-op in production builds),
// `<svelte:boundary onerror={rayBoundary()}>`, and SvelteKit `handleError` hooks. No svelte import:
// these are plain callbacks.
import { ray, type Ray } from '@thewonderjoy/gaze-js';

/** `$inspect(...).with(rayInspect)`: each init/update becomes a new entry labelled with its type. */
export function rayInspect(type: 'init' | 'update', ...values: unknown[]): void {
  ray(...values).label(`$inspect ${type}`);
}

/** `$inspect(...).with(rayInspector('cart'))`: one entry, updated in place on every change. */
export function rayInspector(label?: string): (type: 'init' | 'update', ...values: unknown[]) => void {
  let r: Ray | undefined;
  return (type, ...values) => {
    r ??= ray();
    r.send(...values).label(label ?? `$inspect`);
    if (type == 'update') r.blue();
  };
}

/** `<svelte:boundary onerror={rayBoundary('Checkout')}>`; calls `next` afterwards if given. */
export function rayBoundary(label = 'svelte:boundary', next?: (error: unknown, reset: () => void) => void): (error: unknown, reset: () => void) => void {
  return (error, reset) => {
    ray().exception(error).label(label);
    next?.(error, reset);
  };
}

/** SvelteKit `handleError` for hooks.client.ts / hooks.server.ts. Returns `{ message }`. */
export function rayHandleError({ error, event, status, message }: { error: unknown; event?: { url?: URL; route?: { id?: string | null } }; status?: number; message?: string }): { message: string } {
  ray().exception(error, { status, url: event?.url?.href, route: event?.route?.id }).label('SvelteKit');
  return { message: message ?? 'Internal Error' };
}

export { ray };
