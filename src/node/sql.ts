// SQL from Node database drivers, folded per trace like gaze-laravel's QueryWatcher. mysql2 (3.20+) and
// postgres.js (4+) publish TracingChannels; pg, better-sqlite3 and mariadb do not, so their prototypes are
// patched: every copy the app resolves, through a module.registerHooks resolve hook (Node 22.15+ / 23.5+;
// Prisma's driver adapters bring their own nested copies), else the copy the project resolves from its
// working directory. ORMs on top (Prisma 7 driver adapters, Drizzle, Kysely, Knex) are covered through the
// driver.
//
// Body (kind query) matches gaze-laravel: sql (values filled in, for display), template, bindings, driver,
// time_ms, fingerprint, flags.
// Inside a trace, the same SQL shape running more than `threshold` times folds into its first entry
// (op update with executions[]) and the separate rows already sent are removed; later runs update it at
// powers of two and once more when the trace closes. Outside any trace every query is its own row.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { now, type Ctx, type Scope } from '../core/client.js';
import { uuid7 } from '../core/ids.js';
import type { RayFn } from '../core/ray.js';
import { serialize } from '../core/serialize.js';
import { callerFrames, isOwn } from '../core/stack.js';
import type { Frame, Origin, Value, WireEntry } from '../core/types.js';

const G = globalThis as Record<string, any>;

export interface QueryOptions {
  /** Runs of one SQL shape per trace before they fold into one N+1 entry (default 3). */
  threshold?: number;
  /** Queries at least this slow get the `slow` flag (default 100 ms; /auto passes GAZE_SLOW_QUERY_MS). */
  slowMs?: number;
  /** Where drivers are resolved from (default process.cwd()). */
  root?: string;
}

/** The SQL with literals, placeholders and IN lists reduced, so runs that differ only in values match. */
export function shape(sql: string): string {
  return sql
    .replace(/'(?:[^'\\]|\\.|'')*'/g, '?')
    .replace(/\$\d+|\?|\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)/g, '(?)')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const literal = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v == 'number' || typeof v == 'bigint' || typeof v == 'boolean') return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  const t = typeof v == 'object' ? JSON.stringify(v) : String(v);
  return `'${(t.length > 200 ? t.slice(0, 200) + '…' : t).replace(/'/g, "''")}'`;
};

/** A display copy of `sql` with its `?` and `$n` placeholders filled in (quoted text left alone). */
export function inline(sql: string, values: unknown[]): string {
  if (!values.length) return sql;
  let i = 0;
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\$(\d+)|\?/g, (m, n?: string) => {
    if (m[0] == "'" || m[0] == '"' || m[0] == '`') return m;
    const k = n ? Number(n) - 1 : i++;
    return k < values.length ? literal(values[k]) : m;
  });
}

export function fingerprint(sql: string, driver = ''): string {
  const s = driver + '\0' + shape(sql);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return 'q:' + (h >>> 0).toString(16).padStart(8, '0');
}

interface Exec {
  bindings: Value[];
  time_ms: number;
  offset_ms: number;
}

interface Group {
  id: string;
  body: Record<string, unknown>;
  origin?: Origin;
  count: number;
  rows: string[];
  ex: Exec[];
  total: number;
  dup: boolean;
  slow: boolean;
  grouped: boolean;
  dirty: boolean;
}

interface QState {
  groups: Map<string, Group>;
  exact: Set<string>;
}

type Done = (err?: unknown) => void;
export type Rec = (driver: string, sql: unknown, values: unknown) => Done;

const round = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The first frame outside node_modules, Node internals, generated ORM clients and this package (sync
 * stack plus V8's `at async` frames, which stop at thenables such as Drizzle's and Prisma's queries).
 */
function appOrigin(map?: (f: Frame) => Frame): Origin | undefined {
  for (const x of callerFrames(undefined, 40)) {
    if (x.vendor || isOwn(x.file)) continue;
    const f = map ? map(x) : x;
    if (f.vendor || /[\\/]generated[\\/]prisma[\\/]/.test(f.file)) continue;
    return { file: f.file, line: f.line, col: f.col, ...(f.function ? { function: f.function } : {}) };
  }
}

export function captureQueries(ray: RayFn, ctx: Ctx | undefined, o: QueryOptions = {}): { undo: () => void; rec: Rec } {
  const c = ray.$client;
  const threshold = Math.max(1, o.threshold ?? 3);
  const slowMs = o.slowMs ?? 100;
  const KEY = 'queries';
  const state = (s: Scope): QState => ((s[KEY] as QState) ??= { groups: new Map(), exact: new Set() });

  const send = (op: 'add' | 'update', id: string, body: Record<string, unknown>, trace: WireEntry['trace'], origin: Origin | undefined, flags: string[]) => {
    const e: WireEntry = { op, id, seq: 0, kind: 'query', body: { ...body, flags }, trace };
    if (origin) e.origin = origin;
    if (flags.includes('n+1')) e.color = 'orange';
    else if (flags.includes('slow')) e.color = 'red';
    c.push(e);
  };

  const sendGroup = (g: Group, trace: WireEntry['trace']) => {
    g.dirty = false;
    const flags = ['n+1', ...(g.dup ? ['dup'] : []), ...(g.slow ? ['slow'] : [])];
    const body: Record<string, unknown> = { ...g.body, count: g.count, total_ms: round(g.total), executions: g.ex, n_plus_one: { count: g.count, threshold } };
    if (g.count > g.ex.length) body.executions_cut = g.count - g.ex.length;
    send('update', g.id, body, trace, g.origin, flags);
  };

  const rec: Rec = (driver, sql, values) => {
    if (typeof sql != 'string' || !ray.enabled()) return () => {};
    const scope = ctx?.get();
    const trace = scope?.trace;
    const origin = appOrigin(c.p.mapFrame);
    const t0 = now();
    let done = false;
    return (err) => {
      if (done) return;
      done = true;
      const ms = now() - t0;
      const list = Array.isArray(values) ? values : values === undefined || values === null ? [] : [values];
      const bindings = list.map((v) => serialize(v, c.limits, c.redact));
      const fp = fingerprint(sql, driver);
      const body: Record<string, unknown> = { sql: inline(sql, list), template: sql, bindings, driver, time_ms: round(ms), fingerprint: fp };
      if (err !== undefined) body.error = String((err as Error)?.message ?? err);
      const flags: string[] = [];
      if (err !== undefined) flags.push('failed');
      const slow = ms >= slowMs;
      if (slow) flags.push('slow');
      if (!scope || !trace) return send('add', uuid7(), body, undefined, origin, flags);

      const st = state(scope);
      const exact = fp + '\0' + JSON.stringify(bindings);
      const dup = st.exact.has(exact);
      st.exact.add(exact);
      if (dup) flags.push('dup');
      const ex: Exec = { bindings, time_ms: round(ms), offset_ms: round(Date.now() - (trace.started_at ?? Date.now())) };
      const g = st.groups.get(fp);
      if (!g) {
        const id = uuid7();
        st.groups.set(fp, { id, body, origin, count: 1, rows: [], ex: [ex], total: ms, dup, slow, grouped: false, dirty: false });
        return send('add', id, body, trace, origin, flags);
      }
      g.count++;
      g.total += ms;
      g.dup ||= dup;
      g.slow ||= slow;
      if (g.ex.length < 200) g.ex.push(ex);
      if (g.count <= threshold) {
        const id = uuid7();
        g.rows.push(id);
        return send('add', id, body, trace, origin, flags);
      }
      if (!g.grouped) {
        // Threshold crossed: the first entry becomes the group, the separate rows go away.
        g.grouped = true;
        for (const id of g.rows) c.push({ op: 'remove', id, seq: 0 });
        g.rows = [];
        return sendGroup(g, trace);
      }
      g.dirty = true;
      if ((g.count & (g.count - 1)) == 0) sendGroup(g, trace);
    };
  };

  const close = (s: Scope) => {
    const st = s[KEY] as QState | undefined;
    if (st) for (const g of st.groups.values()) if (g.grouped && g.dirty) sendGroup(g, s.trace);
  };

  c.closers.push(close);
  const undo: (() => void)[] = [() => c.closers.splice(c.closers.indexOf(close) >>> 0, 1)];
  const dc = G.process?.getBuiltinModule?.('node:diagnostics_channel');
  const M = Symbol('gaze.query');
  for (const [name, driver] of [
    ['mysql2:query', 'mysql'],
    ['mysql2:execute', 'mysql'],
    ['postgres:query', 'pgsql'],
  ] as const) {
    const tc = dc?.tracingChannel?.(name);
    if (!tc) continue;
    const h = {
      start: (m: any) => (m[M] = rec(driver, m.query ?? m.sql, m.values ?? m.parameters)),
      error: (m: any) => m[M]?.(m.error ?? new Error('query failed')),
      asyncEnd: (m: any) => m[M]?.(),
    };
    tc.subscribe(h);
    undo.push(() => tc.unsubscribe(h));
  }

  const PATCH: Record<string, (m: any, rec: Rec) => (() => void) | undefined> = { pg: patchPg, 'better-sqlite3': patchSqlite, mariadb: patchMariadb };
  const patch = (id: string, m: any) => {
    const u = PATCH[id]!(m?.default ?? m, rec);
    if (u) undo.push(u);
  };
  // What a patch gets: the module, or mariadb's two promise classes, which it does not export.
  const load = (id: string, file: string) => {
    const req = createRequire(file);
    if (id != 'mariadb') return req(file);
    const lib = join(file, file.endsWith('.cjs') ? '../../lib' : '../lib');
    return { ConnectionPromise: req(join(lib, 'connection-promise.js')), PoolPromise: req(join(lib, 'pool-promise.js')) };
  };
  // Every copy the app resolves, from anywhere (Prisma's adapters bring their own nested drivers):
  // the resolve hook loads and patches the copy before the importer gets it. Node 22.15+ / 23.5+.
  const mod = G.process?.getBuiltinModule?.('node:module');
  let hooked = false;
  if (mod?.registerHooks) {
    let off = false;
    try {
      const h = mod.registerHooks({
        resolve(spec: string, context: unknown, next: (s: string, c: unknown) => { url: string; format?: string }) {
          let r = next(spec, context);
          if (off || !PATCH[spec] || !r.url.startsWith('file:')) return r;
          // mariadb's CommonJS build is one bundle with its classes inside. require() gets the ES build
          // instead: the same exports, with each class in a file of its own.
          const esm = spec == 'mariadb' && r.url.endsWith('/dist/promise.cjs') && new URL('../promise.js', r.url);
          if (esm && existsSync(esm)) r = { ...r, url: esm.href, format: 'module' };
          try {
            patch(spec, load(spec, fileURLToPath(r.url)));
          } catch {}
          return r;
        },
      });
      undo.push(() => ((off = true), h.deregister?.()));
      hooked = true;
    } catch {} // Jest throws: the hook would reach Node's loader, not the one its tests run in.
  }
  // Copies the app loaded before capture was installed (e.g. `ray.capture()` after `import pg`), and
  // without the hook (older Node, Bun, Jest) the project's own copy, loaded now. mariadb's classes are
  // always loaded: an ES module leaves no require.cache entry to look for.
  try {
    const req = createRequire(join(o.root ?? G.process.cwd(), 'noop.js'));
    for (const id in PATCH)
      try {
        const path = req.resolve(id);
        const m = id == 'mariadb' ? load(id, path) : (req.cache[path]?.exports ?? (hooked ? undefined : req(path)));
        if (m) patch(id, m);
      } catch {}
  } catch {}
  return { undo: () => undo.forEach((f) => f()), rec };
}

/**
 * node-postgres: `Client.prototype.query` (Pool.query and pg adapters end up there). `Pool.connect`
 * callbacks are bound to the caller's async context: a busy pool hands a freed client to the next
 * waiter from inside the previous request's callback, which would put its queries in that trace.
 */
export function patchPg(pg: any, rec: Rec): (() => void) | undefined {
  const P = pg?.Client?.prototype;
  if (!P?.query || P.query.$gaze) return;
  const q = P.query;
  const PP = pg.Pool?.prototype;
  const connect = PP?.connect;
  const AR = G.process?.getBuiltinModule?.('node:async_hooks')?.AsyncResource;
  if (connect && AR)
    PP.connect = function (this: unknown, cb?: unknown) {
      return connect.call(this, typeof cb == 'function' ? AR.bind(cb) : cb);
    };
  P.query = Object.assign(
    function (this: unknown, config: any, values?: any) {
      const text = typeof config == 'string' ? config : config?.text;
      // Submittables (cursors, streams) report on their own schedule; leave them alone.
      if (typeof text != 'string' || typeof config?.submit == 'function') return q.apply(this, arguments);
      const done = rec('pgsql', text, Array.isArray(values) ? values : config?.values);
      const args = [...arguments];
      const i = args.findIndex((a, j) => j > 0 && typeof a == 'function');
      if (i > 0) {
        const cb = args[i];
        args[i] = function (this: unknown, err: unknown) {
          done(err ?? undefined);
          return cb.apply(this, arguments);
        };
        return q.apply(this, args);
      }
      const r = q.apply(this, args);
      if (r && typeof r.then == 'function')
        r.then(
          () => done(),
          (e: unknown) => done(e),
        );
      return r;
    },
    { $gaze: true },
  );
  return () => {
    P.query = q;
    if (PP && connect) PP.connect = connect;
  };
}

/** better-sqlite3: statements from `prepare()` (run/get/all/iterate) and `exec()`. Synchronous. */
export function patchSqlite(D: any, rec: Rec): (() => void) | undefined {
  const P = D?.prototype;
  if (!P?.prepare || P.prepare.$gaze) return;
  const { prepare, exec } = P;
  const timed = (f: Function, self: unknown, args: unknown[], done: Done) => {
    try {
      const r = f.apply(self, args);
      done();
      return r;
    } catch (e) {
      done(e);
      throw e;
    }
  };
  let SP: any;
  const orig: Record<string, Function> = {};
  P.prepare = Object.assign(
    function (this: unknown) {
      const st = prepare.apply(this, arguments);
      if (!SP) {
        SP = Object.getPrototypeOf(st);
        for (const m of ['run', 'get', 'all', 'iterate']) {
          const f = (orig[m] = SP[m]);
          SP[m] = function (this: { source?: string }, ...args: unknown[]) {
            return timed(f, this, args, rec('sqlite', this.source, args.length == 1 && Array.isArray(args[0]) ? args[0] : args));
          };
        }
      }
      return st;
    },
    { $gaze: true },
  );
  P.exec = function (this: unknown, sql: unknown) {
    return timed(exec, this, [sql], rec('sqlite', sql, []));
  };
  return () => {
    P.prepare = prepare;
    P.exec = exec;
    if (SP) Object.assign(SP, orig);
  };
}

/**
 * mariadb 3: `query` and `execute` of the promise API's connections and pools (Prisma's MySQL adapter
 * uses both). A pool runs them on its base connection, not through these, so nothing is recorded twice.
 * Not covered: `batch()`, `prepare()`, `queryStream()` and the callback API.
 */
export function patchMariadb(m: { ConnectionPromise?: any; PoolPromise?: any }, rec: Rec): (() => void) | undefined {
  const saved: [any, string, Function][] = [];
  for (const C of [m?.ConnectionPromise, m?.PoolPromise]) {
    const P = (C?.default ?? C)?.prototype;
    for (const name of ['query', 'execute']) {
      const f = P?.[name];
      if (typeof f != 'function' || f.$gaze) continue;
      saved.push([P, name, f]);
      P[name] = Object.assign(
        function (this: unknown, sql: any, values?: unknown) {
          const done = rec('mariadb', typeof sql == 'string' ? sql : sql?.sql, values ?? sql?.values);
          const r = f.apply(this, arguments);
          if (r && typeof r.then == 'function')
            r.then(
              () => done(),
              (e: unknown) => done(e),
            );
          return r;
        },
        { $gaze: true },
      );
    }
  }
  if (saved.length) return () => saved.forEach(([P, name, f]) => (P[name] = f));
}
