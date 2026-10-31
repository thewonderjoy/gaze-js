// Node, Bun and Deno: global fetch (undici keeps connections alive), env defaults, hostname/pid,
// `beforeExit` flush. Deno: env and hostname are read only when already permitted, so importing this
// module never triggers a permission prompt.
import { AsyncLocalStorage } from 'node:async_hooks';
import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Ctx, Platform, Scope } from '../core/client.js';
import type { Frame, Options, Wire } from '../core/types.js';
import { VERSION } from '../version.js';

const G = globalThis as Record<string, any>;
const P = G.process;
const D = G.Deno;
const B = G.Bun;

const allowed = (desc: object): boolean => {
  try {
    return !D || D.permissions.querySync(desc).state == 'granted';
  } catch {
    return false;
  }
};
const env = (k: string): string | undefined => (allowed({ name: 'env', variable: k }) ? P?.env?.[k] || undefined : undefined);

/** GAZE_HOST/GAZE_PORT, then RAY_HOST/RAY_PORT; GAZE_ENABLED; NODE_ENV=production disables. */
export function envDefaults(): Options {
  const o: Options = {};
  const host = env('GAZE_HOST') ?? env('RAY_HOST');
  if (host) o.host = host;
  const port = Number(env('GAZE_PORT') ?? env('RAY_PORT'));
  if (port > 0) o.port = port;
  const on = env('GAZE_ENABLED');
  if (on) o.enabled = !/^(0|false|off|no)$/i.test(on);
  else if (env('NODE_ENV') == 'production') o.enabled = false;
  const wire = env('GAZE_WIRE');
  if (wire == 'native' || wire == 'ray' || wire == 'auto') o.wire = wire as Wire;
  const token = env('GAZE_TOKEN');
  if (token) o.token = token;
  return o;
}

/** Gaze is off for this process: the entries export the no-op and /auto installs nothing. */
export const off = (): boolean => envDefaults().enabled === false;

async function request(url: string, init: RequestInit, ms: number): Promise<[number, string]> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  // Read the body so undici can reuse the connection.
  return [res.status, await res.text()];
}

// One store per process, on globalThis: a bundled copy of this package (Next.js bundles server code)
// and the copy loaded by `--import …/auto` must see the same trace. Made on first use, so importing
// this module (also while Gaze is off) creates nothing.
const S = globalThis as Record<symbol, AsyncLocalStorage<Scope> | undefined>;
const als = (): AsyncLocalStorage<Scope> => (S[Symbol.for('gaze.ctx')] ??= new AsyncLocalStorage<Scope>());
export const ctx: Ctx = {
  get: () => als().getStore(),
  run: (s, fn) => als().run(s, fn),
  enter: (s) => als().enterWith(s),
};

// Frames in generated code (Next.js / Turbopack chunks, tsc or esbuild output) map back to the source
// through the file's `sourceMappingURL` (a .map file or an inline data: URL), read once per file with
// Node's built-in module.SourceMap. Files under node_modules are not looked at. Not in Deno, where
// reading a file could prompt for permission.
interface SM {
  findEntry(line: number, col: number): { originalSource?: string; originalLine?: number; originalColumn?: number };
}
/** A parsed map and the URL its relative `sources` resolve against (the map file, plus sourceRoot). */
type Loaded = { sm: SM; base: URL };
const maps = new Map<string, Loaded | null>();
const builtin = (id: string): any => (D ? undefined : P?.getBuiltinModule?.(id));

function load(SourceMap: new (j: unknown) => SM, json: string, at: URL): Loaded {
  const j = JSON.parse(json);
  const root = typeof j.sourceRoot == 'string' && j.sourceRoot ? j.sourceRoot.replace(/\/?$/, '/') : '';
  return { sm: new SourceMap(j), base: new URL(root, at) };
}

function sourceMap(file: string): Loaded | null {
  const hit = maps.get(file);
  if (hit !== undefined) return hit;
  let m: Loaded | null = null;
  const fs = builtin('node:fs');
  const SourceMap = builtin('node:module')?.SourceMap;
  if (fs && SourceMap)
    try {
      const fd = fs.openSync(file, 'r');
      let tail: string;
      try {
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(Math.min(size, 4096));
        fs.readSync(fd, buf, 0, buf.length, size - buf.length);
        tail = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      const url = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(tail)?.[1];
      // A large inline map does not fit in the tail; those files are left unmapped.
      const at = pathToFileURL(file);
      if (url?.startsWith('data:')) {
        const i = url.indexOf(',');
        m = load(SourceMap, Buffer.from(url.slice(i + 1), url.slice(0, i).endsWith(';base64') ? 'base64' : 'utf8').toString(), at);
      } else if (url) {
        const mapUrl = new URL(url, at);
        m = load(SourceMap, fs.readFileSync(mapUrl, 'utf8'), mapUrl);
      }
    } catch {}
  if (maps.size > 1000) maps.clear();
  maps.set(file, m);
  return m;
}

/** `f` mapped to its source when its file has a source map; otherwise `f` itself. */
export function mapFrame<F extends Frame>(f: F): F {
  if (!f.line || f.vendor) return f;
  try {
    const path = f.file.startsWith('file:') ? fileURLToPath(f.file) : f.file;
    if (!isAbsolute(path)) return f;
    const map = sourceMap(path);
    const e = map?.sm.findEntry(f.line - 1, (f.col ?? 1) - 1);
    const src = e?.originalSource;
    if (!map || !src || e.originalLine === undefined) return f;
    // Relative sources (tsc: "../src/app.ts") resolve against the map; webpack://, turbopack:// and
    // other virtual sources have no file to open.
    const u = isAbsolute(src) ? pathToFileURL(src) : new URL(src, map.base);
    if (u.protocol != 'file:') return f;
    const file = fileURLToPath(u);
    const m: F = { ...f, file, line: e.originalLine + 1, col: (e.originalColumn ?? 0) + 1 };
    if (/node_modules[\\/]/.test(file)) m.vendor = true;
    return m;
  } catch {
    return f;
  }
}

let host: string | null | undefined;

export const node: Platform = {
  runtime: B ? 'bun' : D ? 'deno' : 'node',
  version: B ? B.version : D ? D.version?.deno : P?.versions?.node,
  get host() {
    if (host === undefined)
      try {
        host = allowed({ name: 'sys', kind: 'hostname' }) ? hostname() : null;
      } catch {
        host = null;
      }
    return host ?? undefined;
  },
  pid: P?.pid,
  defaults: envDefaults,
  type: 'application/json',
  headers: (ray) => ({ 'User-Agent': ray ? `Ray 1.0 (gaze-js/${VERSION})` : `gaze-js/${VERSION}` }),
  post: async (url, body, headers) => (await request(url, { method: 'POST', body, headers }, 10000))[0],
  get: async (url, headers, ms) => {
    const [status, text] = await request(url, { headers }, ms);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status, json };
  },
  ctx,
  mapFrame,
  onExit: (fn) => P?.on?.('beforeExit', fn),
  mem: () => P.memoryUsage().heapUsed,
  exit: (code) => P.exit(code),
};
