// Client: one per runtime (process, page, worker). Entries queue synchronously; one microtask later the
// tick moves them to the outbox as one batch (RFC-0001 §4: one request per tick, chained modifiers
// folded into the pending entry). The outbox sends with at most one request in flight, backs off 1-30 s
// while the app is down and keeps a bounded drop-oldest queue (500 entries / 5 MB). Nothing here throws
// into user code, and diagnostics go through the console captured before any patching.
import { uuid7 } from './ids.js';
import type { RayMeta, rayEnvelope } from './ray-wire.js';
import { LIMITS, redactor } from './serialize.js';
import type { Bridge, Client as ClientJson, Frame, Limits, LockState, Mods, Options, WireEntry, Wire } from './types.js';
import { VERSION } from '../version.js';

export const NAME = '@thewonderjoy/gaze-js';

export interface Platform {
  runtime: ClientJson['runtime'];
  version?: string;
  host?: string;
  pid?: number;
  /** Defaults from the environment (Node: GAZE_*, RAY_*, NODE_ENV). */
  defaults?: () => Options;
  /** HTTP POST; resolves the status (0 = opaque no-cors response), rejects on network errors. */
  post: (url: string, body: string, headers: Record<string, string>, noCors: boolean) => Promise<number>;
  /** HTTP GET returning status and parsed JSON (undefined when not JSON). */
  get: (url: string, headers: Record<string, string>, ms: number) => Promise<{ status: number; json?: any }>;
  /** Headers every request carries (Node: User-Agent). */
  headers?: (ray: boolean) => Record<string, string>;
  /** Body type: `application/json` (servers) or `text/plain;charset=UTF-8` (browsers: no preflight). */
  type: string;
  /** Page unload hook + beacon (browsers). */
  onHide?: (fn: () => void) => void;
  beacon?: (url: string, body: string) => boolean;
  /** Process exit hook (Node `beforeExit`). */
  onExit?: (fn: () => void) => void;
  /** Local Network Access gate before the first direct request (browsers). */
  gate?: (host: string) => Promise<boolean>;
  mem?: () => number;
  exit?: (code: number) => void;
  /** Ray-compat origin hostname. */
  rayHost?: string;
  /** Async context for the active trace (Node, Bun, Deno: AsyncLocalStorage). */
  ctx?: Ctx;
  /** Map a frame in generated code (a bundler's chunk) to its source through the file's source map. */
  mapFrame?: <F extends Frame>(f: F) => F;
}

/** What one async context carries: its trace, plus state that capture modules keep per trace. */
export interface Scope {
  trace?: WireEntry['trace'];
  [k: string]: unknown;
}

export interface Ctx {
  get(): Scope | undefined;
  run<T>(s: Scope, fn: () => T): T;
  /** Make `s` current for the rest of this synchronous run and what it schedules. */
  enter(s: Scope): void;
}

export type Encoder = typeof rayEnvelope;

/** The console as it was before any capture module patched it. */
const con = globalThis.console;
const warn = con && con.warn ? con.warn.bind(con) : () => {};
const warned = new Set<string>();
export const hint = (msg: string): void => {
  if (!warned.has(msg)) {
    warned.add(msg);
    warn(`[gaze] ${msg}`);
  }
};

/**
 * A production build: `process.env.NODE_ENV` as a bundler bakes it in (Vite, webpack, Next.js, and
 * esbuild when minifying, replace the expression). False where nothing defines it, e.g. without a bundler.
 */
export const productionBuild = (): boolean => {
  try {
    return process.env.NODE_ENV === 'production';
  } catch {
    return false;
  }
};

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[?::1\]?|[^/]*\.localhost)$/i;
export const isLoopback = (host: string): boolean => LOOPBACK.test(host);

export const now = (): number => {
  const p = globalThis.performance;
  return p && p.timeOrigin ? p.timeOrigin + p.now() : Date.now();
};

const timer = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return t;
};

interface Item {
  e: WireEntry;
  s: string;
}

export class Client {
  cfg: Required<Pick<Options, 'enabled' | 'host' | 'port' | 'wire' | 'origin'>> & Options;
  limits: Limits = LIMITS;
  redact?: RegExp;
  hello?: Record<string, any>;
  /** Wire mode in effect (auto resolves through hello). */
  wire: Wire = 'native';
  #trace?: WireEntry['trace'];
  /** Run on a trace's scope just before its summary row (capture modules flush per-trace state). */
  closers: ((s: Scope) => void)[] = [];
  /** Ray-compat encoder, loaded on first use (keeps it out of the core bundle). */
  enc?: Encoder;
  #load?: () => Promise<Encoder>;
  #q: WireEntry[] = [];
  #last = new Map<string, WireEntry>();
  #sched = false;
  #seq = 0;
  #sid?: string;
  #items: Item[] = [];
  #bytes = 0;
  #dropped = 0;
  #busy = false;
  #retry?: ReturnType<typeof setTimeout>;
  #fails = 0;
  #waiters: ((ok: boolean) => void)[] = [];
  #ready?: Promise<void>;

  constructor(
    public p: Platform,
    load?: () => Promise<Encoder>,
  ) {
    this.#load = load;
    this.cfg = { enabled: true, host: 'localhost', port: 23517, wire: 'native', origin: true };
    this.configure(p.defaults ? p.defaults() : {});
    p.onHide?.(() => this.beacon());
    p.onExit?.(() => {
      if (this.#q.length || (this.#items.length && !this.#retry && !this.#busy)) void this.flush();
    });
  }

  /** Trace (group) applied to new entries: per async context where the platform has one. */
  get trace(): WireEntry['trace'] {
    return this.p.ctx ? this.p.ctx.get()?.trace : this.#trace;
  }

  set trace(t: WireEntry['trace']) {
    this.#trace = t;
  }

  configure(o: Options): void {
    for (const k in o) if ((o as any)[k] !== undefined) (this.cfg as any)[k] = (o as any)[k];
    this.wire = this.cfg.wire;
    this.limits = { ...LIMITS, ...this.cfg.limits };
    this.#ready = undefined;
    this.#fails = 0;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = undefined;
  }

  get session(): string {
    return (this.#sid ??= uuid7());
  }

  base(): string {
    const c = this.cfg;
    if (c.url) return c.url.replace(/\/+$/, '');
    const h = c.host.includes(':') && c.host[0] != '[' ? `[${c.host}]` : c.host;
    return `http://${h}:${c.port}`;
  }

  // ---- entries -------------------------------------------------------------------------------

  /** Queue an entry (seq/ts assigned now) and schedule the tick. */
  push(e: WireEntry): WireEntry {
    e.seq = this.#seq++;
    e.ts = now();
    if (this.trace && !e.trace) e.trace = this.trace;
    this.#q.push(e);
    this.#last.set(e.id, e);
    if (!this.#sched) {
      this.#sched = true;
      queueMicrotask(() => this.tick());
    }
    return e;
  }

  /** Content for `id`: folded into a pending add/update/patch of the same id, else a new entry. */
  content(id: string, op: 'add' | 'update' | 'append', kind: string, body: Record<string, unknown>, extra?: Partial<WireEntry>): WireEntry {
    const p = this.#last.get(id);
    if (p && op != 'append' && p.op != 'append' && p.op != 'remove') {
      if (p.op == 'patch') p.op = op;
      p.kind = kind;
      p.body = body;
      return Object.assign(p, extra);
    }
    return this.push({ op, id, seq: 0, kind, body, ...extra });
  }

  /** Modifiers for `id`: folded into the pending entry, else a `patch`. */
  modify(id: string, m: Mods): void {
    const p = this.#last.get(id);
    if (p && p.op != 'remove') Object.assign(p, m);
    else this.push({ op: 'patch', id, seq: 0, ...m });
  }

  /** Move this tick's entries to the outbox. */
  tick(): void {
    this.#sched = false;
    const q = this.#q;
    if (!q.length) return;
    this.#q = [];
    this.#last.clear();
    const qo = this.cfg.queue;
    for (const e of q) {
      const s = JSON.stringify(e);
      this.#items.push({ e, s });
      this.#bytes += s.length;
    }
    while (this.#items.length > (qo?.entries ?? 500) || this.#bytes > (qo?.bytes ?? 5e6)) {
      this.#bytes -= this.#items.shift()!.s.length;
      this.#dropped++;
    }
    void this.#pump();
  }

  // ---- outbox --------------------------------------------------------------------------------

  /** Send everything queued; resolves true when drained, false when the app is unreachable. */
  flush(): Promise<boolean> {
    this.tick();
    if (!this.#items.length && !this.#busy) return Promise.resolve(true);
    if (this.#retry) return Promise.resolve(false);
    return new Promise((r) => {
      this.#waiters.push(r);
      void this.#pump();
    });
  }

  #settle(ok: boolean): void {
    const w = this.#waiters;
    this.#waiters = [];
    for (const r of w) r(ok);
  }

  headers(ray: boolean): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': this.p.type, ...this.p.headers?.(ray) };
    const c = this.cfg;
    if (c.token && !isLoopback(c.url ? new URL(c.url).hostname : c.host)) h.Authorization = `Bearer ${c.token}`;
    return h;
  }

  /** Hello handshake (native/auto) and the browser LNA gate, once per configuration. */
  #prepare(): Promise<void> {
    const c = this.cfg;
    if (c.bridge || c.wire == 'ray') return Promise.resolve();
    return (this.#ready ??= (async () => {
      if (this.p.gate && !c.url && !(await this.p.gate(c.host))) {
        c.enabled = false;
        return;
      }
      let r: { status: number; json?: any };
      try {
        r = await this.p.get(this.base() + '/v1/hello', this.p.headers?.(false) ?? {}, 1000);
      } catch (e) {
        this.#ready = undefined;
        throw e;
      }
      const h = r.status == 200 && r.json && r.json.v == 1 ? r.json : undefined;
      if (h) {
        this.hello = h;
        const l = h.limits || {};
        if (l.max_string_chars) this.limits.string = Math.min(this.limits.string, l.max_string_chars);
        if (l.max_value_nodes) this.limits.nodes = Math.min(this.limits.nodes, l.max_value_nodes);
        this.redact = redactor(h.redact);
        this.wire = 'native';
      } else if (c.wire == 'auto') this.wire = 'ray';
      else hint(`${this.base()} has no GET /v1/hello (a Ray app?); try wire: 'ray'`);
    })());
  }

  meta(): RayMeta {
    const pr = this.cfg.project;
    return { project_name: (typeof pr == 'string' ? pr : pr?.name) ?? '', client_name: NAME, client_version: VERSION };
  }

  /** Batch JSON up to (not including) the entries, which are appended by string concatenation. */
  #prefix(): string {
    const p = this.p;
    const c = this.cfg;
    const pr = c.project;
    const client: ClientJson = {
      name: NAME,
      version: VERSION,
      runtime: p.runtime,
      runtime_version: p.version,
      framework: c.framework,
      framework_version: c.framework_version,
      host: p.host,
      pid: p.pid,
      project: typeof pr == 'string' ? { name: pr } : pr,
    };
    return `{"v":1,"client":${JSON.stringify(client)},"session":"${this.session}","entries":[`;
  }

  /** Native batch body for up to `max` bytes of queued entries: [body, entries consumed]. */
  #batch(max: number): [string, number] {
    const pre = this.#prefix();
    const items = this.#items;
    let n = 0;
    let size = pre.length;
    while (n < items.length && n < 5000 && (n == 0 || size + items[n]!.s.length < max)) size += items[n++]!.s.length + 1;
    return [pre + items.slice(0, n).map((i) => i.s).join(',') + ']}', n];
  }

  #ray(e: WireEntry): string {
    return this.enc!(e, this.meta(), this.p.rayHost ?? this.p.host ?? 'remote');
  }

  async #pump(): Promise<void> {
    if (this.#busy || this.#retry) return;
    if (!this.#items.length) return this.#settle(true);
    const c = this.cfg;
    this.#busy = true;
    try {
      await this.#prepare();
      if (!c.enabled) (this.#items = []), (this.#bytes = 0);
      if (!this.#items.length) throw 1;
      const ray = this.wire == 'ray';
      if (ray && !this.enc) this.enc = await this.#load!();
      const [body, n] = ray ? [this.#ray(this.#items[0]!.e), 1] : this.#batch(4e6);
      const path = ray ? '/' : '/v1/batch';
      // An envelope without payloads (e.g. an empty patch) is skipped.
      const st = !body.includes('"payloads":[]') ? (c.bridge ? (c.bridge.post(path, body), 202) : await this.p.post(this.base() + path, body, this.headers(ray), ray && this.p.type[0] == 't')) : 202;
      if (st == 429 || st >= 500) throw 0;
      if (st >= 400) hint(`the app rejected a batch (HTTP ${st}); dropped`);
      for (const i of this.#items.splice(0, n)) this.#bytes -= i.s.length;
      this.#fails = 0;
      if (this.#dropped) {
        this.content(uuid7(), 'add', 'text', { text: `${this.#dropped} entries were dropped while the app was unreachable.` }, { label: 'gaze', color: 'orange' });
        this.#dropped = 0;
      }
    } catch (e) {
      this.#busy = false;
      if (e === 1) return this.#settle(true);
      // Down (network error, 429, 5xx): back off 1, 2, 4 … 30 s, keep the queue.
      this.#retry = timer(() => {
        this.#retry = undefined;
        void this.#pump();
      }, Math.min(30000, 1000 * 2 ** this.#fails++));
      return this.#settle(false);
    }
    this.#busy = false;
    void this.#pump();
  }

  /** pagehide: hand what fits into 64 KiB to sendBeacon (text/plain). */
  beacon(): void {
    this.tick();
    const b = this.p.beacon;
    const ray = this.wire == 'ray';
    if (!b || this.cfg.bridge || (ray && !this.enc)) return;
    let budget = 65000;
    while (this.#items.length) {
      const [body, n] = ray ? [this.#ray(this.#items[0]!.e), 1] : this.#batch(budget);
      if (body.length > budget || !b(this.base() + (ray ? '/' : '/v1/batch'), body)) return;
      budget -= body.length;
      this.#items.splice(0, n);
    }
  }

  /**
   * Native: `GET /v1/locks/{id}?wait=25` until released; Ray: poll `GET /locks/{name}` every second.
   * The id is an entry id, but over the Vite bridge any page sends it, so it must stay one path segment.
   */
  async lock(id: string): Promise<LockState> {
    const ray = this.wire == 'ray';
    const b = this.cfg.bridge;
    if (b) return b.lock ? b.lock(id, ray) : 'released';
    if (!/^[\w.:-]{8,64}$/.test(id)) return 'released';
    const seg = encodeURIComponent(id);
    for (;;) {
      try {
        const r = await this.p.get(this.base() + (ray ? `/locks/${seg}` : `/v1/locks/${seg}?wait=25`), this.headers(ray), 30000);
        const j = r.json;
        if (r.status != 200 || !j) return 'released';
        if (!ray) {
          if (j.state != 'active') return j.state ?? 'released';
          continue;
        }
        if (j.stop_execution) return 'stopped';
        if (!j.active) return 'released';
        await new Promise((r) => timer(r as () => void, 1000));
      } catch {
        return 'released';
      }
    }
  }
}

export type { Bridge };
