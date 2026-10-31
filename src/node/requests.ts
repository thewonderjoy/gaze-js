// Node HTTP server requests as traces, with no middleware (Express, Fastify, Hono, Nest, Next…): the
// `http.server.request.start` diagnostics channel opens one trace per request and enters it into the
// async context, so ray(), console, fetch and queries in the handler carry it; `http.server.response.
// finish` sends the summary row (kind request) that closes it, or the response's `close` when the client
// went away first. The request and response emitters are wrapped too: their listeners run in the
// socket's context, and under Node 24's AsyncContextFrame that drops the request inside hand-written
// req.on('data'/'end') readers (framework body parsers already bind their callbacks). Dev-server
// traffic (Vite modules, Next chunks, HMR, images…) opens no trace. Not covered: node:http2 servers,
// Bun.serve and Deno.serve, which publish no such channel.
import { now, type Ctx, type Scope } from '../core/client.js';
import { traceId, uuid7 } from '../core/ids.js';
import type { RayFn } from '../core/ray.js';

const G = globalThis as Record<string, any>;
const ASSET = new Set(['script', 'style', 'image', 'font', 'audio', 'video', 'track', 'manifest', 'worker', 'sharedworker', 'serviceworker']);
const DEV = /^\/(?:@vite\/|@fs\/|@id\/|@react-refresh|node_modules\/|_next\/|__nextjs|__webpack|__vite|favicon\.ico)/;
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** Whether a request is dev-server plumbing rather than the app's own work. */
export const skipRequest = (q: { url?: string; headers?: Record<string, unknown> }): boolean =>
  DEV.test(q.url ?? '') || ASSET.has(String(q.headers?.['sec-fetch-dest'] ?? ''));

export function captureRequests(ray: RayFn, ctx: Ctx | undefined): () => void {
  const dc = G.process?.getBuiltinModule?.('node:diagnostics_channel');
  if (!dc || !ctx) return () => {};
  const c = ray.$client;
  const open = new WeakMap<object, [Scope, number]>();

  const start = ({ request: q, response: s }: { request: any; response: any }) => {
    if (!ray.enabled() || skipRequest(q)) return;
    const url = String(q.url ?? '/');
    const trace: NonNullable<Scope['trace']> = { id: traceId(), kind: 'http', name: `${q.method} ${url.replace(/[?#].*$/, '')}`, started_at: Date.now() };
    // An incoming W3C traceparent names the caller's span: the parent, which the app resolves to
    // the call. Never the id (requests of one distributed trace would merge), as in gaze-laravel.
    const m = TRACEPARENT.exec(String(q.headers?.traceparent ?? '').trim().toLowerCase());
    if (m && !/^0+$/.test(m[1]!) && !/^0+$/.test(m[2]!)) trace.parent = m[2]!;
    const scope: Scope = { trace };
    ctx.enter(scope);
    for (const em of [q, s]) {
      const emit = em.emit;
      em.emit = function (this: unknown) {
        return ctx.run(scope, () => emit.apply(this, arguments));
      };
    }
    open.set(s, [scope, now()]);
    // The client went away before the response finished: close the trace anyway.
    s.once?.('close', () => finish({ request: q, response: s }, true));
  };

  const finish = ({ request: q, response: s }: { request: any; response: any }, closed = false) => {
    const o = open.get(s);
    if (!o) return;
    open.delete(s);
    const [scope, t0] = o;
    for (const f of c.closers) f(scope);
    const aborted = closed && !s.writableFinished;
    const status = aborted ? 0 : Number(s.statusCode) || 0;
    const host = q.headers?.host;
    const body: Record<string, unknown> = {
      method: q.method,
      url: host ? `${q.socket?.encrypted ? 'https' : 'http'}://${host}${q.url}` : q.url,
      uri: q.url,
      status,
      duration_ms: Math.round((now() - t0) * 1000) / 1000,
    };
    if (aborted) body.aborted = true;
    c.push({
      op: 'add',
      id: uuid7(),
      seq: 0,
      kind: 'request',
      body,
      trace: { ...scope.trace!, ended: true },
      ...(status >= 500 ? { color: 'red' } : status >= 400 || aborted ? { color: 'orange' } : {}),
    });
  };

  dc.subscribe('http.server.request.start', start);
  dc.subscribe('http.server.response.finish', finish);
  return () => {
    dc.unsubscribe('http.server.request.start', start);
    dc.unsubscribe('http.server.response.finish', finish);
  };
}
