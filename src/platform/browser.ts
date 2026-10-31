// Browsers and workers: text/plain POSTs (a CORS "simple request": no preflight), credentials omitted,
// low priority; sendBeacon on pagehide; Local Network Access gate before the first direct request.
import { hint, isLoopback, type Platform } from '../core/client.js';

const G = globalThis as Record<string, any>;
const loc = G.location as Location | undefined;
const doc = G.document as Document | undefined;

/**
 * Chrome 142+/Firefox 151+ gate public -> loopback requests behind a permission. Query the
 * `loopback-network` permission (never the legacy name, which can crash older renderers); when it is
 * still a prompt, wait for the first user gesture; when denied, give up with one hint.
 */
export async function lnaGate(host: string): Promise<boolean> {
  if (!loc || !isLoopback(host) || isLoopback(loc.hostname) || /\.test$/i.test(loc.hostname)) return true;
  try {
    const st = await G.navigator.permissions.query({ name: 'loopback-network' });
    if (st.state == 'denied') {
      hint(`loopback-network permission denied for ${loc.origin}; use the Vite plugin or a backend relay (url option).`);
      return false;
    }
    if (st.state == 'prompt' && doc)
      await new Promise((r) => {
        for (const t of ['pointerdown', 'keydown']) G.addEventListener(t, r, { once: true, capture: true });
      });
  } catch {}
  return true;
}

export const browser: Platform = {
  runtime: doc ? 'browser' : 'worker',
  host: loc?.host,
  rayHost: loc?.hostname || 'remote',
  type: 'text/plain;charset=UTF-8',
  post: (url, body, headers, noCors) =>
    fetch(url, {
      method: 'POST',
      body,
      headers,
      credentials: 'omit',
      mode: noCors ? 'no-cors' : 'cors',
      priority: 'low',
      // Chrome: lets an https page reach http://localhost (mixed-content exemption for loopback).
      ...(loc?.protocol == 'https:' && { targetAddressSpace: 'loopback' }),
    } as RequestInit).then((r) => (r.type == 'opaque' ? 202 : r.status)),
  get: (url, headers, ms) =>
    fetch(url, { headers, credentials: 'omit', signal: AbortSignal.timeout?.(ms) }).then(async (r) => ({
      status: r.status,
      json: await r.json().catch(() => undefined),
    })),
  onHide: (fn) => {
    if (!doc) return;
    G.addEventListener('pagehide', fn);
    doc.addEventListener('visibilitychange', () => doc.visibilityState == 'hidden' && fn());
  },
  beacon: (url, body) => !!G.navigator?.sendBeacon?.(url, body),
  gate: lnaGate,
  mem: G.performance?.memory ? () => G.performance.memory.usedJSHeapSize : undefined,
};
