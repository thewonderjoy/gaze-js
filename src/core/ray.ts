// The public API. `ray(...)` captures the call site and serializes its arguments synchronously, then
// returns a chainable `Ray`. Every method returns `this` synchronously except pass(), counterValue(),
// pause(), die() and the static flush()/capture(). Chained modifiers on an entry that has not been
// sent yet are folded into it, so `ray(x).blue().label('a')` is one entry in one request.
import { Client, hint, isLoopback, now, type Encoder, type Platform, type Scope } from './client.js';
import { traceId, uuid7 } from './ids.js';
import { className, plain, serialize, str } from './serialize.js';
import { callerFrames, parseStack } from './stack.js';
import type { Color, Frame, LockState, Mods, Options, Origin, Size, Value, WireEntry } from './types.js';

export type { Color, LockState, Options, Origin, Size, Value };

const COLORS: Record<string, Color> = {
  green: 'green',
  orange: 'orange',
  yellow: 'orange',
  red: 'red',
  purple: 'purple',
  blue: 'blue',
  gray: 'gray',
  grey: 'gray',
};
const SIZES: Record<string, Size> = { sm: 'sm', small: 'sm', md: 'md', lg: 'lg', large: 'lg' };

interface Watch {
  t0: number;
  t: number;
  m: number;
}

/** State shared by every Ray of one client. */
interface Shared {
  c: Client;
  on: boolean;
  counters: Map<string, { n: number; id: string }>;
  limits: Map<string, number>;
  watches: Map<string, Watch>;
  rate: RateLimiter;
}

export class RateLimiter {
  #max = 0;
  #per = 0;
  #n = 0;
  #sec = 0;
  #inSec = 0;
  #hit = false;
  constructor(private notify: () => void) {}
  /** Total sends allowed until clear(). */
  max(n: number): this {
    this.#max = n;
    return this;
  }
  perSecond(n: number): this {
    this.#per = n;
    return this;
  }
  /** Removes both limits and resets the counts, as in gaze-php and spatie/ray. */
  clear(): this {
    this.#max = this.#per = 0;
    this.#n = this.#inSec = 0;
    this.#hit = false;
    return this;
  }
  /** @internal */
  ok(): boolean {
    const s = Math.floor(Date.now() / 1000);
    if (s != this.#sec) {
      this.#sec = s;
      this.#inSec = 0;
    }
    if ((this.#max && this.#n >= this.#max) || (this.#per && this.#inSec >= this.#per)) {
      if (!this.#hit) {
        this.#hit = true;
        this.notify();
      }
      return false;
    }
    this.#n++;
    this.#inSec++;
    return true;
  }
}

const fp = (o?: Origin): string => (o ? `${o.file}:${o.line}:${o.col}` : '?');
const nop = (): void => {};
const one = (v: Value[]): Value => (v.length == 1 ? v[0]! : { k: 'list', count: v.length, items: v });

function errBody(err: unknown, ser: (v: unknown) => Value, meta?: unknown, depth = 0, map?: (f: Frame) => Frame): Record<string, unknown> {
  const e = err instanceof Error ? (err as Error & { cause?: unknown; code?: unknown; errors?: unknown }) : undefined;
  const frames = e ? parseStack(e.stack) : [];
  const body: Record<string, unknown> = e
    ? { class: String(e.name || className(e)), message: String(e.message), frames: map ? frames.map((f) => (f.vendor ? f : map(f))) : frames }
    : { class: typeof err, message: typeof err == 'object' ? JSON.stringify(plain(ser(err))) : String(err), frames: [] };
  const ctx: Record<string, unknown> = {};
  if (e) {
    if (typeof e.code == 'string' || Number.isInteger(e.code)) body.code = e.code;
    if ('cause' in e) {
      ctx.cause = e.cause;
      if (e.cause instanceof Error && depth < 5) body.previous = errBody(e.cause, ser, undefined, depth + 1, map);
    }
    if (Array.isArray(e.errors)) ctx.errors = e.errors;
  }
  if (meta !== undefined) {
    if (meta && typeof meta == 'object' && !Array.isArray(meta)) Object.assign(ctx, meta);
    else ctx.meta = meta;
  }
  for (const _ in ctx) {
    body.context = ser(ctx);
    break;
  }
  return body;
}

/** Wire ids must be 8-64 characters. */
const wireId = (id: string): string => {
  id = String(id);
  if (id.length >= 8 && id.length <= 64) return id;
  if (id.length < 8) return ('at:' + id).padEnd(8, '_');
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return id.slice(0, 50) + ':' + (h >>> 0).toString(16);
};

export class Ray {
  #s: Shared;
  #id?: string;
  #o?: Origin;
  #sent = false;
  #off = false;

  /** @internal */
  constructor(s: Shared, origin?: Origin, id?: string, sent = false, off = false) {
    this.#s = s;
    this.#o = origin;
    this.#id = id;
    this.#sent = sent;
    this.#off = off;
  }

  /** Entry id (stable across updates); `ray.at(id)` targets it later. */
  get id(): string {
    return (this.#id ??= uuid7());
  }

  #live(): boolean {
    return !this.#off && this.#s.on && this.#s.c.cfg.enabled;
  }

  #ser = (v: unknown): Value => serialize(v, this.#s.c.limits, this.#s.c.redact);

  /** @internal Send content of any kind with this entry's id. */
  $emit(kind: string, body: Record<string, unknown>, op?: 'append'): this {
    const s = this.#s;
    if (!this.#live() || !s.rate.ok()) return this;
    const sent = this.#sent;
    this.#sent = true;
    s.c.content(this.id, op ?? (sent ? 'update' : 'add'), kind, body, this.#o ? { origin: this.#o } : undefined);
    return this;
  }

  #mod(m: Mods): this {
    if (this.#live()) this.#s.c.modify(this.id, m);
    return this;
  }

  #cmd(cmd: string, extra?: Record<string, unknown>): this {
    if (this.#live()) this.#s.c.push({ op: 'add', id: uuid7(), seq: 0, kind: 'cmd', body: { cmd, ...extra } });
    return this;
  }

  // ---- content -------------------------------------------------------------------------------

  /** Dump values (one `log` entry). */
  send(...values: unknown[]): this {
    return values.length && this.#live() ? this.$emit('log', { values: values.map(this.#ser) }) : this;
  }
  /** Same as send(): JS values are never converted to HTML, so there is nothing to bypass. */
  declare raw: (...values: unknown[]) => this;
  /** Send `value` and return it unchanged. */
  pass<T>(value: T): T {
    this.send(value);
    return value;
  }
  /** Append values as a new iteration of this entry (RFC op `append`). */
  append(...values: unknown[]): this {
    return this.#live() ? this.$emit('log', { values: values.map(this.#ser) }, 'append') : this;
  }
  /** Custom entry kind (`^[a-z][a-z0-9_.-]*$`) with a JSON body; unknown kinds render as a tree. */
  entry(kind: string, body: Record<string, unknown>): this {
    // The app rejects a whole batch over one bad kind, so normalise it here.
    const k = String(kind).toLowerCase().replace(/[^a-z0-9_.-]/g, '_').slice(0, 63);
    return this.$emit(/^[a-z]/.test(k) ? k : 'x' + k, body && typeof body == 'object' && !Array.isArray(body) ? body : { value: body });
  }
  text(text: unknown): this {
    return this.$emit('text', { text: String(text) });
  }
  html(html: unknown): this {
    return this.$emit('html', { html: String(html) });
  }
  markdown(markdown: unknown): this {
    return this.$emit('markdown', { markdown: String(markdown) });
  }
  mermaid(source: unknown): this {
    return this.$emit('mermaid', { source: String(source) });
  }
  /** Decode JSON strings and show them as trees. */
  json(...json: string[]): this {
    if (!this.#live()) return this;
    return this.$emit('json', {
      value: one(
        json.map((j) => {
          try {
            return this.#ser(JSON.parse(j));
          } catch {
            return this.#ser(j);
          }
        }),
      ),
    });
  }
  /** Show values as a JSON tree. */
  toJson(...values: unknown[]): this {
    return this.#live() ? this.$emit('json', { value: one(values.map(this.#ser)) }) : this;
  }
  xml(xml: string): this {
    return this.$emit('text', { text: String(xml).replace(/>\s*</g, '>\n<'), lang: 'xml' });
  }
  /** Key/value table (object, Map, array), or a column table for an array of plain objects. */
  table(data: unknown, label?: string): this {
    if (!this.#live()) return this;
    const body: Record<string, unknown> = {};
    if (label) body.label = String(label);
    const recs = Array.isArray(data) && data.length > 0 && data.every((r) => r && typeof r == 'object' && !Array.isArray(r));
    if (recs) {
      const cols: string[] = [];
      for (const r of data.slice(0, 200)) for (const k of Object.keys(r)) if (!cols.includes(k) && cols.length < 50) cols.push(k);
      body.columns = cols;
      body.rows = data.slice(0, 200).map((r) => cols.map((c) => this.#ser(Object.getOwnPropertyDescriptor(r, c)?.value)));
    } else {
      const pairs: [unknown, unknown][] =
        data instanceof Map ? [...data] : data && typeof data == 'object' ? Object.entries(data) : [['value', data]];
      body.entries = pairs.slice(0, 200).map(([k, v]) => [String(k), this.#ser(v)]);
    }
    return this.$emit('table', body);
  }
  /** Image by URL, path or base64 data. */
  image(src: string): this {
    const s = String(src);
    return this.$emit('image', { src: /^[A-Za-z0-9+/=\s]{64,}$/.test(s) ? 'data:image/png;base64,' + s : s });
  }
  date(d: Date | number | string = new Date()): this {
    const t = new Date(d);
    const p = (n: number) => String(n).padStart(2, '0');
    let tz: string | null = null;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    } catch {}
    const ok = t.getTime() == t.getTime();
    return this.$emit('date', {
      formatted: ok
        ? `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`
        : null,
      timestamp: ok ? t.getTime() / 1000 : null,
      timezone: tz,
    });
  }
  className(value: unknown): this {
    return this.send(value !== null && typeof value == 'object' ? className(value) : typeof value);
  }
  separator(): this {
    return this.$emit('separator', {});
  }

  // ---- modifiers -----------------------------------------------------------------------------

  color(color: Color | 'yellow' | 'grey'): this {
    const c = COLORS[color];
    return c ? this.#mod({ color: c }) : this;
  }
  declare green: () => this;
  declare orange: () => this;
  /** Ray alias of orange(). */
  declare yellow: () => this;
  declare red: () => this;
  declare purple: () => this;
  declare blue: () => this;
  declare gray: () => this;
  declare grey: () => this;
  size(size: Size | 'small' | 'large'): this {
    const s = SIZES[size];
    return s ? this.#mod({ size: s }) : this;
  }
  declare small: () => this;
  declare large: () => this;
  label(label: unknown): this {
    return this.#mod({ label: String(label).slice(0, 200) });
  }
  hide(): this {
    return this.#mod({ hidden: true });
  }
  /** `expand()` = level 1, `expand(3)`, `expand('a.b', 'c')` = key paths. */
  expand(...levelOrPaths: (number | string)[]): this {
    let level: number | undefined;
    const paths: string[] = [];
    for (const a of levelOrPaths) typeof a == 'number' ? (level = Math.max(level ?? 0, Math.floor(a) || 0)) : paths.push(String(a));
    return this.#mod({ expand: paths.length ? (level === undefined ? { paths } : { level, paths }) : { level: level ?? 1 } });
  }
  expandAll(): this {
    return this.expand(999);
  }
  remove(): this {
    const c = this.#s.c;
    if (this.#live() && this.#id) c.push({ op: 'remove', id: this.#id, seq: 0 });
    return this;
  }

  // ---- screens and app -----------------------------------------------------------------------

  newScreen(name = ''): this {
    return this.#cmd('new_screen', { name: String(name) });
  }
  clearScreen(): this {
    return this.newScreen('');
  }
  clearAll(): this {
    return this.#cmd('clear');
  }
  screenColor(color: Color): this {
    const c = COLORS[color];
    return c ? this.#cmd('screen_color', { color: c }) : this;
  }
  showApp(): this {
    return this.#cmd('show_app');
  }
  hideApp(): this {
    return this.#cmd('hide_app');
  }
  notify(text: unknown): this {
    return this.#cmd('notify', { text: String(text) });
  }
  confetti(): this {
    return this.#cmd('confetti');
  }
  /** Project name for this and later batches. */
  project(name: string): this {
    const c = this.#s.c.cfg;
    c.project = c.project && typeof c.project == 'object' ? { ...c.project, name } : name;
    return this;
  }

  // ---- control -------------------------------------------------------------------------------

  /** `if(false)` mutes this chain; `if(cond, r => ...)` runs the callback when cond holds. */
  if(cond: unknown, cb?: (ray: this) => void): this {
    const v = typeof cond == 'function' ? cond() : cond;
    if (cb) {
      if (v) cb(this);
    } else if (!v) this.#off = true;
    return this;
  }
  showIf(cond: unknown): this {
    return (typeof cond == 'function' ? cond() : cond) ? this : this.remove();
  }
  declare showWhen: (cond: unknown) => this;
  removeIf(cond: unknown): this {
    return (typeof cond == 'function' ? cond() : cond) ? this.remove() : this;
  }
  declare removeWhen: (cond: unknown) => this;
  /** Send only `n` times per call site (fingerprint: file:line:col of the ray() call). */
  limit(n: number): this {
    if (n > 0) {
      const k = fp(this.#o);
      const c = this.#s.limits.get(k) ?? 0;
      if (c >= n) this.#off = true;
      else this.#s.limits.set(k, c + 1);
    }
    return this;
  }
  once(...values: unknown[]): this {
    return this.limit(1).send(...values);
  }
  /** Count calls per name (or per call site); one entry updated in place. Returns that entry's Ray. */
  count(name?: string): Ray {
    const s = this.#s;
    if (!this.#live()) return this;
    const k = name ?? fp(this.#o);
    let c = s.counters.get(k);
    if (!c) s.counters.set(k, (c = { n: 0, id: uuid7() }));
    c.n++;
    const r = new Ray(s, this.#o, c.id, c.n > 1);
    return r.$emit('log', { values: [str(`Called ${name ? '`' + name + '` ' : ''}${c.n} time${c.n == 1 ? '' : 's'}.`, 200)] });
  }
  counterValue(name: string): number {
    return this.#s.counters.get(name)?.n ?? 0;
  }
  clearCounters(): this {
    this.#s.counters.clear();
    return this;
  }
  rateLimiter(): RateLimiter {
    return this.#s.rate;
  }
  enable(): this {
    this.#s.on = this.#s.c.cfg.enabled = true;
    return this;
  }
  disable(): this {
    this.#s.on = false;
    return this;
  }
  enabled(): boolean {
    return this.#s.on && this.#s.c.cfg.enabled;
  }
  disabled(): boolean {
    return !this.enabled();
  }

  // ---- debugging -----------------------------------------------------------------------------

  /** Stack frames of the call site (`limit` frames, our own frames removed). */
  trace(limit = 25): this {
    return this.#live() ? this.$emit('trace', { frames: callerFrames(this.trace, limit) }) : this;
  }
  backtrace(limit = 25): this {
    return this.#live() ? this.$emit('trace', { frames: callerFrames(this.backtrace, limit) }) : this;
  }
  /** The frame that called the function that called ray(). */
  caller(): this {
    if (!this.#live()) return this;
    const f: Frame[] = callerFrames(this.caller, 2);
    return this.$emit('trace', { frames: f.slice(f.length > 1 ? 1 : 0) });
  }
  /** Error with its own stack (err.stack), cause chain and AggregateError members, coloured red. */
  exception(err: unknown, meta?: Record<string, unknown>): this {
    if (!this.#live()) return this;
    return this.$emit('exception', errBody(err, this.#ser, meta, 0, this.#s.c.p.mapFrame)).red();
  }
  /** Stopwatch by name (first call starts it), or time a (sync or async) function. Disabled, the function still runs. */
  measure(nameOrFn: string | (() => unknown) = 'default'): this {
    if (!this.#live()) {
      if (typeof nameOrFn == 'function') {
        // As when timed: a throw reaches the caller, a rejection is settled here.
        const r = nameOrFn() as Promise<unknown> | undefined;
        if (r && typeof r.then == 'function') r.then(nop, nop);
      }
      return this;
    }
    const mem = this.#s.c.p.mem;
    const m = mem ? mem() : 0;
    const t = now();
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    if (typeof nameOrFn == 'function') {
      const done = () => {
        const ms = r3(now() - t);
        this.$emit('measure', { name: nameOrFn.name || 'closure', total_ms: ms, since_last_ms: ms, is_new: false, ...(mem && { mem_peak: mem(), mem_delta: mem() - m }) });
      };
      let r: unknown;
      try {
        r = nameOrFn();
      } catch (e) {
        done();
        throw e;
      }
      if (r && typeof (r as Promise<unknown>).then == 'function') (r as Promise<unknown>).then(done, done);
      else done();
      return this;
    }
    const name = String(nameOrFn);
    const w = this.#s.watches.get(name);
    this.#s.watches.set(name, { t0: w ? w.t0 : t, t, m });
    return this.$emit('measure', {
      name,
      total_ms: w ? r3(t - w.t0) : 0,
      since_last_ms: w ? r3(t - w.t) : 0,
      is_new: !w,
      ...(mem && { mem_peak: m, mem_delta: w ? m - w.m : 0 }),
    });
  }
  stopTime(name?: string): this {
    name === undefined ? this.#s.watches.clear() : this.#s.watches.delete(name);
    return this;
  }
  /**
   * Pause until "Continue" (or "Stop") in the app. Non-blocking: await it. Resolves 'released' at once
   * when the app is unreachable, never hangs.
   */
  async pause(): Promise<LockState> {
    if (!this.#live()) return 'released';
    const c = this.#s.c;
    this.$emit('lock', { name: this.id });
    if (!(await c.flush())) return 'released';
    return c.lock(this.id);
  }
  /** Flush, then end the process (Node/Bun/Deno: exit code) or reject (browsers). Await it. Disabled, it does nothing. */
  async die(code = 1): Promise<void> {
    if (!this.enabled()) return;
    await this.#s.c.flush();
    const exit = this.#s.c.p.exit;
    if (exit) exit(code);
    throw new Error('ray().die()');
  }
}

{
  const P = Ray.prototype as any;
  for (const k in COLORS)
    P[k] = function (this: Ray) {
      return this.color(k as Color);
    };
  P.small = function (this: Ray) {
    return this.size('sm');
  };
  P.large = function (this: Ray) {
    return this.size('lg');
  };
  P.raw = P.send;
  P.showWhen = P.showIf;
  P.removeWhen = P.removeIf;
}

export interface WatchOptions {
  /** Poll interval in ms (default 500). */
  interval?: number;
  label?: string;
}

export interface CaptureOptions {
  console?: boolean;
  errors?: boolean;
  network?: boolean;
  /** Node: one trace per incoming HTTP request, closed by a request summary row. */
  requests?: boolean;
  /** Node: SQL from pg, mysql2, postgres.js and better-sqlite3, with N+1 folding per trace. */
  queries?: boolean;
}

export interface RayFn {
  (...values: unknown[]): Ray;
  /** Ray bound to an explicit entry id: `ray.at('cart').send(cart)` updates one entry in place. */
  at(id: string): Ray;
  /** @internal Call-site tagged factory emitted by the Vite plugin's call-site transform. */
  at$(file: string, line: number, col: number): (...values: unknown[]) => Ray;
  /** Re-send `getter()` to one entry whenever its value changes; returns a stop function. */
  watch(getter: () => unknown, options?: WatchOptions): () => void;
  /** Send everything queued; resolves when delivered (or the app is unreachable). */
  flush(): Promise<void>;
  configure(options: Options): RayFn;
  /** Install console / error / network capture; resolves to an uninstall function. Disabled, installs nothing. */
  capture(options?: CaptureOptions): Promise<() => void>;
  /** Run `fn` as one unit of work: entries carry a shared trace; a summary entry closes it. Disabled, just runs `fn`. */
  group<T>(label: string, fn: () => T): T;
  enable(): RayFn;
  disable(): RayFn;
  enabled(): boolean;
  disabled(): boolean;
  clearCounters(): RayFn;
  rateLimiter(): RateLimiter;
  /** Add a chainable method: `ray.macro('double', function (n) { return this.send(n * 2) })`. */
  macro(name: string, fn: (this: Ray, ...args: any[]) => unknown): RayFn;
  /** @internal A Ray without a call site (events observed outside user code). */
  $bare(): Ray;
  /** @internal A Ray at a given origin (capture modules pick the app's own frame). */
  $at(origin?: Origin): Ray;
  /** @internal */
  readonly $client: Client;
}

export interface Loaders {
  capture?: () => Promise<{ install: (ray: RayFn, o?: CaptureOptions) => () => void }>;
  ray?: () => Promise<Encoder>;
}

/** Build the `ray` function for one platform. */
export function createRay(p: Platform, load: Loaders = {}): RayFn {
  const c = new Client(p, load.ray);
  const s: Shared = {
    c,
    on: true,
    counters: new Map(),
    limits: new Map(),
    watches: new Map(),
    rate: new RateLimiter(() => {
      c.content(uuid7(), 'add', 'text', { text: 'Rate limit has been reached...' }, { label: 'Rate limit' });
    }),
  };
  const OFF = new Ray(s, undefined, undefined, false, true);
  const live = () => s.on && c.cfg.enabled;
  const site = (fn: Function): Origin | undefined => {
    const f = c.cfg.origin ? callerFrames(fn, 1)[0] : undefined;
    return f && p.mapFrame ? p.mapFrame(f) : f;
  };

  const ray = function ray(...values: unknown[]): Ray {
    if (!live()) return OFF;
    const r = new Ray(s, site(ray));
    return values.length ? r.send(...values) : r;
  } as RayFn;

  const statics: Omit<RayFn, '$client'> = {
    at: function at(id: string) {
      return live() ? new Ray(s, site(at), wireId(id)) : OFF;
    },
    at$(file, line, col) {
      return (...values: unknown[]) => {
        if (!live()) return OFF;
        const r = new Ray(s, { file, line, col });
        return values.length ? r.send(...values) : r;
      };
    },
    $bare: () => (live() ? new Ray(s) : OFF),
    $at: (o) => (live() ? new Ray(s, o) : OFF),
    watch: function watch(getter, o = {}) {
      if (!live()) return () => {};
      const r = new Ray(s, site(watch));
      if (o.label) r.label(o.label);
      let last: string | undefined;
      const check = () => {
        let v: unknown;
        try {
          v = getter();
        } catch (e) {
          v = e;
        }
        const val = serialize(v, c.limits, c.redact);
        const j = JSON.stringify(val);
        if (j !== last) {
          last = j;
          r.$emit('log', { values: [val] });
        }
      };
      check();
      const t = setInterval(check, o.interval ?? 500);
      (t as { unref?: () => void }).unref?.();
      return () => clearInterval(t);
    },
    flush: () => (live() ? c.flush().then(nop) : Promise.resolve()),
    configure(o) {
      c.configure(o);
      if (o.enabled !== undefined) s.on = o.enabled;
      return ray;
    },
    // Disabled, nothing is loaded or patched.
    capture(o) {
      return load.capture && live() ? load.capture().then((m) => m.install(ray, o)) : Promise.resolve(nop);
    },
    group(label, fn) {
      if (!live()) return fn();
      const parent = c.trace;
      const t: NonNullable<WireEntry['trace']> = { id: traceId(), kind: 'other', name: String(label), started_at: Date.now() };
      if (parent) t.parent = parent.id;
      // With an async context (Node) the group follows its own async work only; without one
      // (browsers) it is the current trace until it ends.
      const ctx = c.p.ctx;
      const scope: Scope = { trace: t };
      if (!ctx) c.trace = t;
      const t0 = now();
      const end = () => {
        if (!ctx) c.trace = parent;
        for (const f of c.closers) f(scope);
        if (live())
          c.push({ op: 'add', id: uuid7(), seq: 0, kind: 'group', body: { name: t.name, duration_ms: Math.round((now() - t0) * 1000) / 1000 }, trace: { ...t, ended: true } });
      };
      let r: any;
      try {
        r = ctx ? ctx.run(scope, fn) : fn();
      } catch (e) {
        end();
        throw e;
      }
      if (r && typeof r.then == 'function') r.then(end, end);
      else end();
      return r;
    },
    enable: () => (OFF.enable(), ray),
    disable: () => (OFF.disable(), ray),
    enabled: () => live(),
    disabled: () => !live(),
    clearCounters: () => (s.counters.clear(), ray),
    rateLimiter: () => s.rate,
    macro(name, fn) {
      if (name in Ray.prototype && !(Ray.prototype as any)[name]?.$macro) hint(`macro '${name}' replaces a built-in method`);
      Object.defineProperty(Ray.prototype, name, { value: Object.assign(fn, { $macro: true }), configurable: true, writable: true });
      return ray;
    },
  };
  Object.assign(ray, statics);
  Object.defineProperty(ray, '$client', { value: c });
  return ray;
}

export { isLoopback };
