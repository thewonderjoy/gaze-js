// Errors in a Fastify 5 route. Fastify answers 500 and, with its logger off (the default), prints
// nothing, so neither the console patch nor the uncaught-error handlers see them. It publishes them on
// the `tracing:fastify.request.handler` TracingChannel instead: `error` carries what the handler threw
// or rejected with (or a preHandler hook passed on) and runs in the request's async context, so the
// exception lands in its trace. Only what Fastify's default error handler logs at error level is sent:
// a 5xx status, read as it reads it. Skipped: pause()'s StopExecutionRequested (it only ends the
// request) and an error that an async error handler throws again, which Fastify publishes twice.
// With Fastify's logger on, pino writes JSON to stdout itself, which nothing else here reads.
import { errRay } from '../capture.js';
import type { RayFn } from '../core/ray.js';

const G = globalThis as Record<string, any>;
const ERROR = 'tracing:fastify.request.handler:error';

/** The status Fastify's default error handler gives `err` (lib/error-handler.js, setErrorHeaders). */
const statusOf = (err: any, reply: number): number =>
  err?.status >= 400 ? err.status : err?.statusCode >= 400 ? err.statusCode : reply >= 400 ? reply : 500;

export function captureFastify(ray: RayFn): () => void {
  const dc = G.process?.getBuiltinModule?.('node:diagnostics_channel');
  if (!dc) return () => {};
  const sent = new WeakSet<object>();
  const error = ({ error: e, reply }: { error?: any; reply?: { statusCode?: number } }) => {
    try {
      if (e?.name == 'StopExecutionRequested' || statusOf(e, Number(reply?.statusCode)) < 500) return;
      if (e && typeof e == 'object') {
        if (sent.has(e)) return;
        sent.add(e);
      }
      errRay(ray, e).exception(e);
    } catch {}
  };
  dc.subscribe(ERROR, error);
  return () => dc.unsubscribe(ERROR, error);
}
