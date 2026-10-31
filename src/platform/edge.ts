// Edge runtimes (workerd, Vercel Edge, Next middleware): fetch only, no env, no node: modules.
// Deployed edge code cannot reach a developer machine; this is for local dev servers (wrangler dev).
// Use ctx.waitUntil(ray.flush()) (or Next.js after(() => ray.flush())) so the request outlives the send.
import type { Platform } from '../core/client.js';

export const edge: Platform = {
  runtime: 'edge',
  type: 'application/json',
  post: (url, body, headers) => fetch(url, { method: 'POST', body, headers }).then((r) => (r.body?.cancel(), r.status)),
  get: (url, headers) =>
    fetch(url, { headers }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => undefined) })),
};
