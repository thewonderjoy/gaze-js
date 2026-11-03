// Errors a Fastify 5 route handler throws: Fastify answers 500 and, with its logger off (the default),
// prints nothing, so they reach Gaze through its `tracing:fastify.request.handler` channel.
import dc from 'node:diagnostics_channel';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { install } from '../src/capture-node.js';
import { StopExecutionRequested } from '../src/core/ray.js';
import type { WireEntry } from '../src/core/types.js';
import { ctx, mapFrame } from '../src/platform/node.js';
import { lineOf, makeRay, settle } from './helpers.js';

const here = fileURLToPath(import.meta.url);
const slash = (p?: string) => (p ?? '').replace(/\\/g, '/');
const undo: (() => void)[] = [];
afterEach(() => undo.splice(0).forEach((f) => f()));

const tc = dc.tracingChannel('fastify.request.handler');
type Handler = () => unknown;

/**
 * Fastify 5.12 without Fastify: the channel's events as lib/handle-request.js and lib/wrap-thenable.js
 * publish them (status set before `error`), then an error handler, the default one (status, no log)
 * unless `onError` is given. A promise from `onError` goes through wrap-thenable with the same store.
 */
function fastify(routes: Record<string, Handler>, onError?: (err: any) => unknown): http.RequestListener {
  return (req, res) => {
    const reply = {
      raw: res,
      get statusCode() {
        return res.statusCode;
      },
      code(s: number) {
        res.statusCode = s;
        return reply;
      },
    };
    const store: Record<string, unknown> = { request: { raw: req }, reply, async: false, route: { url: req.url, method: req.method } };
    const fail = (err: any) => {
      store.error = err;
      const s = err && (err.statusCode || err.status);
      reply.code(s >= 400 ? s : 500);
      tc.error.publish(store);
    };
    const handle = (err: any) => {
      const r = onError?.(err);
      if (r instanceof Promise) r.then(() => res.end(), (e) => (fail(e), res.end()));
      else res.end(String(err?.message));
    };
    tc.start.runStores(store, () => {
      try {
        const r = routes[req.url!]!();
        if (!(r instanceof Promise)) return void res.end(String(r));
        store.async = true;
        r.then(
          (v) => (tc.asyncStart.publish(store), res.end(String(v)), tc.asyncEnd.publish(store)),
          (err) => (fail(err), tc.asyncStart.publish(store), handle(err), tc.asyncEnd.publish(store)),
        );
      } catch (err) {
        fail(err);
        handle(err);
      } finally {
        tc.end.publish(store);
      }
    });
  };
}

async function run(app: http.RequestListener, urls: string[], opts = { errors: true, requests: true }): Promise<WireEntry[]> {
  const { ray, entries } = makeRay({ ctx, mapFrame });
  undo.push(install(ray, opts));
  const s = http.createServer(app);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await Promise.all(urls.map((u) => fetch(`http://127.0.0.1:${port}${u}`).then((r) => r.text())));
  s.close();
  await settle(20);
  await ray.flush();
  return entries();
}

const errors = (es: WireEntry[]) => es.filter((e) => e.kind == 'exception');
const traceOf = (es: WireEntry[], uri: string) => es.find((e) => e.kind == 'request' && e.body!.uri == uri)!.trace!.id;

describe('Fastify errors', () => {
  it('sends a 500 from a sync or async handler as an exception in its request, at the throw', async () => {
    const es = await run(
      fastify({
        '/sync': () => {
          throw new Error('sync boom'); // @fastify-sync
        },
        '/async': async () => {
          await settle(Math.random() * 10);
          throw new TypeError('async boom'); // @fastify-async
        },
      }),
      ['/sync', '/async'],
    );
    const ex = errors(es);
    expect(ex.map((e) => e.body!.message).sort()).toEqual(['async boom', 'sync boom']);
    for (const [uri, cls, marker] of [
      ['/sync', 'Error', '@fastify-sync'],
      ['/async', 'TypeError', '@fastify-async'],
    ]) {
      const e = ex.find((x) => x.body!.class == cls)!;
      expect(e.trace?.id, uri).toBe(traceOf(es, uri!));
      expect([slash(e.origin?.file), e.origin?.line]).toEqual([slash(here), lineOf(here, marker!)]);
      expect((e.body!.frames as { line: number }[])[0]!.line).toBe(lineOf(here, marker!));
    }
  });

  it('skips 4xx errors and pause() stops, as Fastify logs them at info', async () => {
    const es = await run(
      fastify({
        '/missing': async () => {
          throw Object.assign(new Error('no such order'), { statusCode: 404 });
        },
        '/gone': () => {
          throw Object.assign(new Error('gone'), { status: 410 });
        },
        '/stop': async () => {
          throw new StopExecutionRequested();
        },
        '/redirect': () => {
          throw Object.assign(new Error('3xx is not an error status'), { statusCode: 302 });
        },
      }),
      ['/missing', '/gone', '/stop', '/redirect'],
    );
    expect(es.filter((e) => e.kind == 'request')).toHaveLength(4);
    expect(errors(es).map((e) => e.body!.message)).toEqual(['3xx is not an error status']);
  });

  it('reports an error once when an async error handler rethrows it', async () => {
    const es = await run(
      fastify({ '/rethrow': () => Promise.reject(new Error('once')) }, async (err) => {
        throw err;
      }),
      ['/rethrow'],
    );
    expect(errors(es).map((e) => e.body!.message)).toEqual(['once']);
  });

  it('is part of the errors module', async () => {
    const es = await run(fastify({ '/x': () => Promise.reject(new Error('off')) }), ['/x'], { errors: false, requests: true });
    expect(errors(es)).toHaveLength(0);
  });
});
