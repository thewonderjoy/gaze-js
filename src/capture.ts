// Opt-in auto-capture: console, errors, network (03 §7.8). Loaded on demand by ray.capture(), or
// installed synchronously by "@thewonderjoy/gaze-js/auto". Wrappers always call through to the
// original, guard against re-entrancy, rate-limit console traffic and never capture our own requests.
// Where the client has an async context (Node), console and network entries take the first frame of
// the app's own code as their origin, and those made only by dependencies outside any trace (framework
// banners, a dev server's update check) are skipped.
import type { CaptureOptions, Ray, RayFn } from './core/ray.js';
import { isLoopback } from './core/client.js';
import { hex, rand, traceId } from './core/ids.js';
import { callerFrames, isOwn, parseStack } from './core/stack.js';
import type { Frame } from './core/types.js';

const G = globalThis as Record<string, any>;
const MODULES = ['console', 'errors', 'network', 'requests', 'queries'] as const;

/** Modules for the /auto entries: globalThis.GAZE_CAPTURE, or in Node GAZE_CAPTURE=errors,network. */
export function autoOptions(): CaptureOptions | undefined {
  const g = G.GAZE_CAPTURE;
  if (g && typeof g == 'object') return Object.fromEntries(MODULES.map((k) => [k, g[k] !== false]));
  let env: string | undefined;
  try {
    if (!G.Deno) env = G.process?.env?.GAZE_CAPTURE;
  } catch {}
  if (!env) return undefined;
  const on = env.split(/[\s,]+/);
  return Object.fromEntries(MODULES.map((k) => [k, on.includes(k)]));
}

const origin = (f?: Frame) => f && { file: f.file, line: f.line, col: f.col, function: f.function, class: f.class };

/**
 * A Ray for something the app did through `boundary` (a patched console method, fetch…). Node: at the
 * first frame of the app's own code (source-mapped); with none, no origin inside a trace and null
 * outside one. Elsewhere: at the caller of `boundary`.
 */
function appRay(ray: RayFn, boundary?: Function): Ray | null {
  const c = ray.$client;
  const frames = callerFrames(boundary, 40);
  if (!c.p.ctx) return ray.$at(origin(frames[0]));
  for (const f of frames) {
    if (isOwn(f.file)) continue;
    const m = c.p.mapFrame ? c.p.mapFrame(f) : f;
    if (!m.vendor) return ray.$at(origin(m));
  }
  return c.trace ? ray.$at() : null;
}
/** A Ray at an error's own first frame outside dependencies (source-mapped in Node). */
function errRay(ray: RayFn, err: unknown): Ray {
  const map = ray.$client.p.mapFrame;
  for (const f of parseStack((err as Error | undefined)?.stack)) {
    if (f.vendor || isOwn(f.file)) continue;
    const m = map ? map(f) : f;
    if (!m.vendor) return ray.$at(origin(m));
  }
  return ray.$bare();
}

const perf = (): number => (G.performance ? G.performance.now() : Date.now());
const ms = (t0: number): number => Math.round((perf() - t0) * 100) / 100;

const LEVELS: Record<string, string> = {
  log: '',
  info: 'blue',
  warn: 'orange',
  error: 'red',
  debug: 'gray',
  trace: '',
  table: '',
  dir: '',
  assert: 'red',
};

export function captureConsole(ray: RayFn, perSecond = 50): () => void {
  const con = G.console;
  const orig: Record<string, Function> = {};
  let busy = false;
  let sec = 0;
  let n = 0;
  for (const m in LEVELS) {
    const f = con?.[m];
    if (typeof f != 'function') continue;
    orig[m] = f;
    const w = function (this: unknown, ...args: unknown[]) {
      if (!busy && !(m == 'assert' && args[0])) {
        busy = true;
        try {
          const s = Math.floor(Date.now() / 1000);
          if (s != sec) (sec = s), (n = 0);
          const r = appRay(ray, w);
          if (r && ++n <= perSecond) {
            r.send(...(m == 'assert' ? args.slice(1) : args)).label('console.' + m);
            if (LEVELS[m]) r.color(LEVELS[m] as 'red');
          }
        } catch {
        } finally {
          busy = false;
        }
      }
      return f.apply(this, args);
    };
    con[m] = w;
  }
  return () => {
    for (const m in orig) con[m] = orig[m];
  };
}

export function captureErrors(ray: RayFn): () => void {
  const P = G.process;
  if (typeof G.addEventListener == 'function') {
    // Browsers, workers, Deno. Capture phase also sees resource load failures (<img>, <script>).
    const onError = (ev: ErrorEvent) => {
      const t = ev.target as HTMLElement | null;
      if (ev.error !== undefined && ev.error !== null) errRay(ray, ev.error).exception(ev.error, { source: 'error event' });
      else if (t && t !== G && (t as { tagName?: string }).tagName)
        ray.$bare()
          .text(`Failed to load <${t.tagName.toLowerCase()}> ${(t as HTMLImageElement).src || (t as HTMLLinkElement).href || ''}`)
          .label('resource error')
          .red();
      else if (ev.message) ray.$bare().exception(new Error(ev.message), { file: ev.filename, line: ev.lineno, col: ev.colno });
    };
    const onRejection = (ev: PromiseRejectionEvent) => errRay(ray, ev.reason).exception(ev.reason, { unhandledRejection: true });
    G.addEventListener('error', onError, true);
    G.addEventListener('unhandledrejection', onRejection);
    return () => {
      G.removeEventListener('error', onError, true);
      G.removeEventListener('unhandledrejection', onRejection);
    };
  }
  if (!P?.on) return () => {};
  // Node/Bun. When nobody else handles fatal errors we take over just long enough to flush, then exit
  // with code 1 like Node would (03 §7.8). Otherwise we only observe and never change crash behaviour.
  const fatal = (err: unknown, origin: string) => {
    try {
      errRay(ray, err).exception(err, { origin });
      P.stderr.write(`${origin}: ${(err as Error)?.stack ?? String(err)}\n`);
    } catch {}
    const exit = () => P.exit(1);
    ray.flush().then(exit, exit);
    setTimeout(exit, 2000).unref?.();
  };
  const off: [string, Function][] = [];
  const on = (ev: string, fn: Function) => (P.on(ev, fn), off.push([ev, fn]));
  if (!P.listenerCount('uncaughtException')) on('uncaughtException', (e: unknown) => fatal(e, 'uncaughtException'));
  else on('uncaughtExceptionMonitor', (e: unknown, origin: string) => errRay(ray, e).exception(e, { origin }));
  if (!P.listenerCount('unhandledRejection')) on('unhandledRejection', (r: unknown) => fatal(r, 'unhandledRejection'));
  on('warning', (w: Error) => ray.$bare().text(`${w.name}: ${w.message}`).label('process.warning').orange());
  return () => {
    for (const [ev, fn] of off) P.off(ev, fn);
  };
}

export function captureNetwork(ray: RayFn): () => void {
  const undo: (() => void)[] = [];
  const own = (url: string) => {
    try {
      return url.startsWith(ray.$client.base());
    } catch {
      return false;
    }
  };
  const report = (r: Ray, method: string, url: string, t0: number, status?: number, error?: unknown, span?: string) => {
    const body: Record<string, unknown> = { method, url, duration_ms: ms(t0) };
    if (status !== undefined) body.status = status;
    if (error !== undefined) body.error = String(error);
    if (span) body.span_id = span;
    r.entry('http', body);
    if (error !== undefined || (status ?? 0) >= 500) r.red();
    else if ((status ?? 0) >= 400) r.orange();
  };

  // A W3C traceparent on calls to the app's own servers, so the app links the server's trace to
  // the call: same origin in browsers (on a cross-origin call the header would need CORS), loopback
  // and *.test hosts elsewhere, plus the `propagate` origins. A traceparent already set (by the app,
  // or OpenTelemetry) is left alone. The span id goes into the call's entry as `span_id`.
  const loc = G.location as { href: string; origin: string } | undefined;
  const target = (url: string): boolean => {
    try {
      const u = new URL(url, loc?.href);
      if ((ray.$client.cfg.propagate ?? []).some((o) => u.origin == o.replace(/\/+$/, ''))) return true;
      return loc ? u.origin == loc.origin : isLoopback(u.hostname.replace(/^\[|\]$/g, '')) || /\.test$/i.test(u.hostname);
    } catch {
      return false;
    }
  };
  /** [header value, span id] for a call made now. */
  const traceparent = (): [string, string] => {
    const span = hex(rand(8));
    return [`00-${ray.$client.trace?.id ?? traceId()}-${span}-01`, span];
  };

  const of = G.fetch;
  if (typeof of == 'function') {
    G.fetch = function fetch(this: unknown, input: any, init?: RequestInit) {
      let url = '';
      let method = 'GET';
      try {
        url = typeof input == 'string' ? input : String(input?.href ?? input?.url ?? input);
        method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
      } catch {}
      const r = own(url) ? null : appRay(ray, fetch);
      if (!r) return of.apply(this, arguments);
      let args: unknown[] = [...arguments];
      let span: string | undefined;
      if (target(url))
        try {
          const h = new Headers(init?.headers ?? (G.Request && input instanceof G.Request ? input.headers : undefined));
          if (!h.has('traceparent')) {
            const [tp, s] = traceparent();
            h.set('traceparent', tp);
            args = [input, { ...init, headers: h }];
            span = s;
          }
        } catch {}
      const t0 = perf();
      const p = of.apply(this, args) as Promise<Response>;
      p.then(
        (res) => report(r, method, url, t0, res.status, undefined, span),
        (err) => report(r, method, url, t0, undefined, err, span),
      );
      return p;
    };
    undo.push(() => (G.fetch = of));
  }

  const X = G.XMLHttpRequest?.prototype;
  if (X) {
    const { open, send, setRequestHeader } = X;
    const meta = new WeakMap<object, [string, string]>();
    const hasTp = new WeakSet<object>();
    X.open = function (this: object, method: string, url: string | URL) {
      meta.set(this, [String(method).toUpperCase(), String(url)]);
      hasTp.delete(this);
      return open.apply(this, arguments);
    };
    X.setRequestHeader = function (this: object, name: string) {
      if (String(name).toLowerCase() == 'traceparent') hasTp.add(this);
      return setRequestHeader.apply(this, arguments);
    };
    X.send = function xsend(this: XMLHttpRequest) {
      const m = meta.get(this);
      const r = m && !own(m[1]) ? appRay(ray, xsend) : null;
      if (m && r) {
        let span: string | undefined;
        if (target(m[1]) && !hasTp.has(this))
          try {
            const [tp, s] = traceparent();
            setRequestHeader.call(this, 'traceparent', tp);
            span = s;
          } catch {}
        const t0 = perf();
        this.addEventListener('loadend', () => report(r, m[0], m[1], t0, this.status || undefined, this.status ? undefined : 'network error', span));
      }
      return send.apply(this, arguments);
    };
    undo.push(() => Object.assign(X, { open, send, setRequestHeader }));
  }

  // Node http/https (and everything built on them, e.g. axios) through diagnostics_channel.
  const dc = G.process?.getBuiltinModule?.('node:diagnostics_channel');
  if (dc) {
    const starts = new WeakMap<object, [Ray, number, string | undefined]>();
    // request.created (Node 22.12+) runs in the caller's context before the headers go out, so the
    // app frame and the trace are known there and a traceparent can still be added; request.start
    // covers older Node, without the header.
    const start = ({ request: q }: { request: any }) => {
      if (starts.has(q)) return;
      const r = appRay(ray);
      if (!r) return;
      let span: string | undefined;
      try {
        if (!q.headersSent && !q.getHeader('traceparent') && target(`${q.protocol}//${q.host}${q.path}`)) {
          const [tp, s] = traceparent();
          q.setHeader('traceparent', tp);
          span = s;
        }
      } catch {}
      starts.set(q, [r, perf(), span]);
    };
    const finish = ({ request: q, response }: { request: any; response: any }) => {
      const url = `${q.protocol}//${q.host}${q.path}`;
      const s = starts.get(q);
      if (s && !own(url)) report(s[0], q.method, url, s[1], response.statusCode, undefined, s[2]);
    };
    dc.subscribe('http.client.request.created', start);
    dc.subscribe('http.client.request.start', start);
    dc.subscribe('http.client.response.finish', finish);
    undo.push(() => {
      dc.unsubscribe('http.client.request.created', start);
      dc.unsubscribe('http.client.request.start', start);
      dc.unsubscribe('http.client.response.finish', finish);
    });
  }
  return () => undo.forEach((f) => f());
}

/** Install the selected capture modules (all three when `options` is omitted). */
export function install(ray: RayFn, o?: CaptureOptions): () => void {
  const undo: (() => void)[] = [];
  if (!o || o.console) undo.push(captureConsole(ray));
  if (!o || o.errors) undo.push(captureErrors(ray));
  if (!o || o.network) undo.push(captureNetwork(ray));
  return () => undo.forEach((f) => f());
}
