// Opt-in auto-capture: console, errors, network (03 §7.8). Loaded on demand by ray.capture(), or
// installed synchronously by "@thewonderjoy/gaze-js/auto". Wrappers always call through to the
// original, guard against re-entrancy, rate-limit console traffic and never capture our own requests.
import type { CaptureOptions, Ray, RayFn } from './core/ray.js';

const G = globalThis as Record<string, any>;
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
    con[m] = function (this: unknown, ...args: unknown[]) {
      if (!busy && !(m == 'assert' && args[0])) {
        busy = true;
        try {
          const s = Math.floor(Date.now() / 1000);
          if (s != sec) (sec = s), (n = 0);
          if (++n <= perSecond) {
            const r = ray(...(m == 'assert' ? args.slice(1) : args)).label('console.' + m);
            if (LEVELS[m]) r.color(LEVELS[m] as 'red');
          }
        } catch {
        } finally {
          busy = false;
        }
      }
      return f.apply(this, args);
    };
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
      if (ev.error !== undefined && ev.error !== null) ray().exception(ev.error, { source: 'error event' });
      else if (t && t !== G && (t as { tagName?: string }).tagName)
        ray()
          .text(`Failed to load <${t.tagName.toLowerCase()}> ${(t as HTMLImageElement).src || (t as HTMLLinkElement).href || ''}`)
          .label('resource error')
          .red();
      else if (ev.message) ray().exception(new Error(ev.message), { file: ev.filename, line: ev.lineno, col: ev.colno });
    };
    const onRejection = (ev: PromiseRejectionEvent) => ray().exception(ev.reason, { unhandledRejection: true });
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
      ray().exception(err, { origin });
      P.stderr.write(`${origin}: ${(err as Error)?.stack ?? String(err)}\n`);
    } catch {}
    const exit = () => P.exit(1);
    ray.flush().then(exit, exit);
    setTimeout(exit, 2000).unref?.();
  };
  const off: [string, Function][] = [];
  const on = (ev: string, fn: Function) => (P.on(ev, fn), off.push([ev, fn]));
  if (!P.listenerCount('uncaughtException')) on('uncaughtException', (e: unknown) => fatal(e, 'uncaughtException'));
  else on('uncaughtExceptionMonitor', (e: unknown, origin: string) => ray().exception(e, { origin }));
  if (!P.listenerCount('unhandledRejection')) on('unhandledRejection', (r: unknown) => fatal(r, 'unhandledRejection'));
  on('warning', (w: Error) => ray().text(`${w.name}: ${w.message}`).label('process.warning').orange());
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
  const report = (r: Ray, method: string, url: string, t0: number, status?: number, error?: unknown) => {
    const body: Record<string, unknown> = { method, url, duration_ms: ms(t0) };
    if (status !== undefined) body.status = status;
    if (error !== undefined) body.error = String(error);
    r.entry('http', body);
    if (error !== undefined || (status ?? 0) >= 500) r.red();
    else if ((status ?? 0) >= 400) r.orange();
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
      if (own(url)) return of.apply(this, arguments);
      const r = ray();
      const t0 = perf();
      const p = of.apply(this, arguments) as Promise<Response>;
      p.then(
        (res) => report(r, method, url, t0, res.status),
        (err) => report(r, method, url, t0, undefined, err),
      );
      return p;
    };
    undo.push(() => (G.fetch = of));
  }

  const X = G.XMLHttpRequest?.prototype;
  if (X) {
    const { open, send } = X;
    const meta = new WeakMap<object, [string, string]>();
    X.open = function (this: object, method: string, url: string | URL) {
      meta.set(this, [String(method).toUpperCase(), String(url)]);
      return open.apply(this, arguments);
    };
    X.send = function (this: XMLHttpRequest) {
      const m = meta.get(this);
      if (m && !own(m[1])) {
        const r = ray();
        const t0 = perf();
        this.addEventListener('loadend', () => report(r, m[0], m[1], t0, this.status || undefined, this.status ? undefined : 'network error'));
      }
      return send.apply(this, arguments);
    };
    undo.push(() => Object.assign(X, { open, send }));
  }

  // Node http/https (and everything built on them, e.g. axios) through diagnostics_channel.
  const dc = G.process?.getBuiltinModule?.('node:diagnostics_channel');
  if (dc) {
    const starts = new WeakMap<object, number>();
    const start = ({ request }: { request: object }) => starts.set(request, perf());
    const finish = ({ request: q, response }: { request: any; response: any }) => {
      const url = `${q.protocol}//${q.host}${q.path}`;
      if (!own(url)) report(ray.$bare(), q.method, url, starts.get(q) ?? perf(), response.statusCode);
    };
    dc.subscribe('http.client.request.start', start);
    dc.subscribe('http.client.response.finish', finish);
    undo.push(() => {
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
