// Vite plugin (dev only by default): injects the browser client, bridges its batches over the HMR
// WebSocket to the app (no CORS, no Local Network Access prompt, works from phones on the LAN), maps
// bridged origins and stack frames from served URLs to source files and lines, does the GET /v1/hello
// handshake, optionally rewrites ray() call sites to carry exact file:line:col, and aliases the
// package to ./noop in builds.
import { SourceMap, type SourceMapPayload, type SourceMapping } from 'node:module';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HtmlTagDescriptor, Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import { Client } from './core/client.js';
import { rayEnvelope } from './core/ray-wire.js';
import type { CaptureOptions } from './core/ray.js';
import type { Options, Wire, WireEntry } from './core/types.js';
import { envDefaults, node } from './platform/node.js';

export interface GazeViteOptions extends Pick<Options, 'host' | 'port' | 'url' | 'wire' | 'token' | 'enabled'> {
  /** Project name shown in the app (default: package.json name via Vite's root folder name). */
  project?: string;
  /** Inject the client into index.html and entry modules (default true). */
  inject?: boolean;
  /** Extra entry modules (relative to the Vite root) to inject into, besides build input. */
  entries?: string[];
  /** Send browser batches over the HMR socket (default true); false = browser posts directly. */
  bridge?: boolean;
  /** Install capture modules in the browser (default false). */
  capture?: boolean | CaptureOptions;
  /** Forward Vite compile errors (vite:error) to the app (default true). */
  viteErrors?: boolean;
  /**
   * Rewrite `ray(` / `gaze(` / `dump(` calls imported from this package so they carry exact
   * file:line:col (AST based, needs Vite 8's TS-aware parser; files that do not parse are left
   * untouched). Default false.
   */
  callSites?: boolean;
  /** Alias `@thewonderjoy/gaze-js` to `@thewonderjoy/gaze-js/noop` in `vite build` (default true). */
  noopInBuild?: boolean;
  /** When the plugin runs (default 'serve'). */
  apply?: Plugin['apply'];
}

export const PKG = '@thewonderjoy/gaze-js';
const VIRTUAL = 'virtual:gaze-client';
const RESOLVED = '\0' + VIRTUAL;

// ---- source maps for small edits (identifier replacements and prepends, never across lines) ---------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const vlq = (n: number): string => {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let s = '';
  do {
    let d = v & 31;
    v >>>= 5;
    if (v) d |= 32;
    s += B64[d];
  } while (v);
  return s;
};

export interface RawMap {
  version: number;
  sources: string[];
  names: string[];
  mappings: string;
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Apply sorted, non-overlapping single-line edits; returns code and a v3 source map. */
export function applyEdits(code: string, edits: Edit[], file: string): { code: string; map: RawMap } {
  let out = '';
  let pos = 0;
  for (const e of edits) {
    out += code.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  out += code.slice(pos);
  const lines: string[] = [];
  let i = 0;
  let prevLine = 0;
  let prevCol = 0;
  let lineStart = 0;
  let line = 0;
  const seg = (gen: number, col: number, acc: string[]) => {
    acc.push(vlq(gen) + 'A' + vlq(line - prevLine) + vlq(col - prevCol));
    prevLine = line;
    prevCol = col;
  };
  for (const text of code.split('\n')) {
    const end = lineStart + text.length;
    const acc: string[] = [];
    let gen = 0;
    let genPrev = 0;
    let col = 0;
    const emit = (c: number) => {
      seg(gen - genPrev, c, acc);
      genPrev = gen;
    };
    emit(0);
    while (i < edits.length && edits[i]!.start <= end) {
      const e = edits[i++]!;
      gen += e.start - lineStart - col;
      col = e.start - lineStart;
      if (gen != genPrev) emit(col);
      gen += e.text.length;
      col = e.end - lineStart;
      emit(col);
    }
    lines.push(acc.join(','));
    lineStart = end + 1;
    line++;
  }
  return { code: out, map: { version: 3, sources: [file], names: [], mappings: lines.join(';') } };
}

// ---- call-site transform -------------------------------------------------------------------------

type Node = { type: string; start: number; end: number; [k: string]: any };
type ParseFn = (code: string, options?: { lang?: string; sourceType?: string }) => Node;

const NAMES = new Set(['ray', 'gaze', 'dump', 'default']);

function walk(n: any, fn: (n: Node) => void): void {
  if (!n || typeof n != 'object') return;
  if (Array.isArray(n)) {
    for (const x of n) walk(x, fn);
    return;
  }
  if (typeof n.type == 'string') fn(n);
  for (const k in n) if (k != 'parent' && n[k] && typeof n[k] == 'object') walk(n[k], fn);
}

/** Edits that tag calls of imported ray/gaze/dump in one parsed script (offsets relative to `base`). */
export function callSiteEdits(program: Node, base: number, code: string, file: string): Edit[] {
  const locals = new Set<string>();
  walk(program, (n) => {
    if (n.type == 'ImportDeclaration' && (n.source.value == PKG || n.source.value == PKG + '/noop'))
      for (const s of n.specifiers ?? []) {
        const imported = s.type == 'ImportDefaultSpecifier' ? 'default' : s.imported?.name ?? s.imported?.value;
        if (s.type != 'ImportNamespaceSpecifier' && NAMES.has(imported)) locals.add(s.local.name);
      }
  });
  if (!locals.size) return [];
  const edits: Edit[] = [];
  walk(program, (n) => {
    const c = n.callee;
    if (n.type == 'CallExpression' && c?.type == 'Identifier' && locals.has(c.name)) {
      const at = base + c.start;
      const before = code.slice(0, at);
      const line = before.split('\n').length;
      const col = at - before.lastIndexOf('\n');
      const f = JSON.stringify(file);
      // Falls back to the plain call when a local binding shadows the import.
      edits.push({ start: at, end: base + c.end, text: `(${c.name}.at$?${c.name}.at$(${f},${line},${col}):${c.name})` });
    }
  });
  return edits.sort((a, b) => a.start - b.start);
}

const LANG: Record<string, string> = { ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', jsx: 'jsx', js: 'js', mjs: 'js', cjs: 'js' };

export function transformCallSites(code: string, id: string, parse: ParseFn): { code: string; map: RawMap } | null {
  const file = id.replace(/[?#].*$/, '');
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  if (!code.includes(PKG) || file.includes('/node_modules/') || id.startsWith('\0')) return null;
  const blocks: [number, string, string][] = [];
  if (ext == 'vue' || ext == 'svelte') {
    for (const m of code.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      const lang = /\blang=["']?(ts|tsx)/.exec(m[1]!)?.[1] ?? 'js';
      blocks.push([m.index! + m[0].indexOf('>') + 1, m[2]!, lang]);
    }
  } else if (LANG[ext]) blocks.push([0, code, LANG[ext]!]);
  const edits: Edit[] = [];
  for (const [base, src, lang] of blocks) {
    let program: Node | undefined;
    for (const l of lang == 'js' ? ['js', 'jsx'] : [lang]) {
      try {
        program = parse(src, { lang: l, sourceType: 'module' });
        break;
      } catch {}
    }
    if (program) edits.push(...callSiteEdits(program, base, code, file));
  }
  return edits.length ? applyEdits(code, edits, file) : null;
}

// ---- Node-side forwarder for bridged batches -------------------------------------------------------

/** Forwards raw request bodies to the app: one in flight, 1-30 s backoff, 500 items / 5 MB queue. */
export class Forwarder {
  private q: [string, string][] = [];
  private bytes = 0;
  private busy = false;
  private retry?: ReturnType<typeof setTimeout>;
  private fails = 0;
  dropped = 0;
  constructor(private c: Client) {}

  push(path: string, body: string): void {
    this.q.push([path, body]);
    this.bytes += body.length;
    while (this.q.length > 500 || this.bytes > 5e6) {
      this.bytes -= this.q.shift()![1].length;
      this.dropped++;
    }
    void this.pump();
  }

  /** A native batch from the browser, re-encoded as Ray envelopes in Ray mode. */
  batch(body: string): void {
    if (this.c.wire != 'ray') return this.push('/v1/batch', body);
    try {
      const b = JSON.parse(body) as { client?: { project?: { name?: string } }; entries: WireEntry[] };
      const meta = { ...this.c.meta(), project_name: b.client?.project?.name ?? this.c.meta().project_name };
      for (const e of b.entries) this.push('/', rayEnvelope(e, meta, 'remote'));
    } catch {}
  }

  private async pump(): Promise<void> {
    if (this.busy || this.retry || !this.q.length) return;
    this.busy = true;
    const [path, body] = this.q[0]!;
    const ray = path == '/';
    try {
      const h: Record<string, string> = { 'Content-Type': 'application/json', ...node.headers!(ray) };
      const t = this.c.cfg.token;
      if (t) h.Authorization = `Bearer ${t}`;
      const st = await node.post(this.c.base() + path, body, h, false);
      if (st == 429 || st >= 500) throw st;
      this.q.shift();
      this.bytes -= body.length;
      this.fails = 0;
    } catch {
      this.fails++;
      this.retry = setTimeout(() => {
        this.retry = undefined;
        void this.pump();
      }, Math.min(30000, 1000 * 2 ** (this.fails - 1)));
      this.retry.unref?.();
    }
    this.busy = false;
    void this.pump();
  }
}

/** GET /v1/hello from Node; resolves the wire mode and a one-line status. */
export async function handshake(c: Client): Promise<string> {
  if (c.cfg.wire == 'ray') return `Ray-compat mode, sending to ${c.base()}`;
  try {
    const r = await node.get(c.base() + '/v1/hello', node.headers!(false), 1500);
    if (r.status == 200 && r.json?.v == 1) {
      c.wire = 'native';
      const s = r.json.server ?? {};
      return `connected to ${s.name ?? 'app'} ${s.version ?? ''} at ${c.base()}`.replace('  ', ' ');
    }
    if (c.cfg.wire == 'auto') {
      c.wire = 'ray';
      return `${c.base()} has no /v1/hello (HTTP ${r.status}); using the Ray wire format`;
    }
    return `${c.base()} answered /v1/hello with HTTP ${r.status}; is it a Ray app? Set wire: 'ray'`;
  } catch {
    return `app not reachable at ${c.base()}; batches are queued until it starts`;
  }
}

// ---- served URLs -> source files and lines, through the dev server's module graph -----------------

type Loc = { file?: unknown; line?: unknown; col?: unknown };
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** A map source as a path: relative to the module, absolute or file:; undefined for virtual sources. */
const sourcePath = (s: string, file: string): string | undefined =>
  s.startsWith('file:')
    ? fileURLToPath(s).replace(/\\/g, '/')
    : s.includes('\0') || (!isAbsolute(s) && /^[a-z][\w+.-]*:/i.test(s))
      ? undefined
      : resolvePath(dirname(file), s).replace(/\\/g, '/');

/**
 * Rewrites a native batch's origins and exception / trace frames (with the `previous` chain) from this
 * dev server's URLs (`http://localhost:5173/src/App.vue`, `/src/App.vue?t=1`) to source paths and
 * lines. Other URLs, node_modules and unknown modules stay as they are. Never rejects: on any error it
 * resolves to the body unchanged.
 */
function sourceMapper(server: ViteDevServer): (body: string) => Promise<string> {
  const maps = new Map<string, { tr: unknown; sm?: SourceMap }>();
  let urls: unknown;
  let origins = new Set<string>();
  const own = (): Set<string> => {
    if (urls === server.resolvedUrls) return origins;
    urls = server.resolvedUrls;
    origins = new Set();
    for (const x of [...(server.resolvedUrls?.local ?? []), ...(server.resolvedUrls?.network ?? []), server.config.server.origin ?? ''])
      try {
        const u = new URL(x);
        origins.add(u.origin);
        // Browsers may reach a loopback server by another loopback name (Laravel's hot file says [::1]).
        if (LOOPBACK.includes(u.hostname)) for (const h of LOOPBACK) origins.add(`${u.protocol}//${h}${u.port ? ':' + u.port : ''}`);
      } catch {}
    return origins;
  };
  /** Root-relative path of a served URL, or undefined when the URL is not this server's. */
  const served = (file: string): string | undefined => {
    let p = file;
    if (!p.startsWith('/') || p.startsWith('//'))
      try {
        const u = new URL(p);
        if (!own().has(u.origin)) return;
        p = u.pathname;
      } catch {
        return;
      }
    p = p.replace(/[?#].*$/, '');
    try {
      p = decodeURI(p);
    } catch {}
    // Absolute paths under the root (POSIX call sites, vite:error) are files already.
    return p.includes('/node_modules/') || p.startsWith(server.config.root + '/') ? undefined : p;
  };
  const lookup = async (p: string) => {
    const mod = await server.environments?.client?.moduleGraph.getModuleByUrl(p);
    if (!mod?.file || mod.file == p || mod.file.includes('/node_modules/')) return;
    const key = mod.id ?? mod.url;
    const tr = mod.transformResult;
    let c = maps.get(key);
    // A new transform (HMR) replaces the cached map; an invalidated module keeps the one the page runs.
    if (!c || (tr && c.tr !== tr)) {
      let sm: SourceMap | undefined;
      try {
        if (tr?.map?.mappings) sm = new SourceMap(tr.map as unknown as SourceMapPayload);
      } catch {}
      maps.set(key, (c = { tr, sm }));
    }
    return { file: mod.file, sm: c.sm };
  };
  const at = async (f: Loc): Promise<boolean> => {
    const p = f && typeof f == 'object' && typeof f.file == 'string' ? served(f.file) : undefined;
    const m = p && (await lookup(p));
    if (!m) return false;
    f.file = m.file;
    if (!m.sm || typeof f.line != 'number') return true;
    const hasCol = typeof f.col == 'number';
    const e = m.sm.findEntry(f.line - 1, hasCol ? (f.col as number) - 1 : 0) as Partial<SourceMapping>;
    const src = e.originalSource && typeof e.originalLine == 'number' ? sourcePath(e.originalSource, m.file) : undefined;
    if (src) {
      f.file = src;
      f.line = e.originalLine! + 1;
      if (hasCol) f.col = e.originalColumn! + 1;
    }
    return true;
  };
  return async (body) => {
    try {
      const b = JSON.parse(body) as { entries?: WireEntry[] };
      const locs: Loc[] = [];
      for (const e of b.entries ?? []) {
        if (e.origin) locs.push(e.origin, ...(e.origin.frames ?? []));
        if (e.kind == 'exception' || e.kind == 'trace')
          for (let x = e.body, d = 0; x && d < 8; x = x.previous as typeof x, d++) if (Array.isArray(x.frames)) locs.push(...x.frames);
      }
      return (await Promise.all(locs.map(at))).includes(true) ? JSON.stringify(b) : body;
    } catch {
      return body;
    }
  };
}

const norm = (p: string): string => {
  const s = p.replace(/\\/g, '/').replace(/[?#].*$/, '');
  return process.platform == 'win32' ? s.toLowerCase() : s;
};

function inputs(config: ResolvedConfig, extra: string[] = []): Set<string> {
  const b = config.build as Record<string, any>;
  const input = b.rolldownOptions?.input ?? b.rollupOptions?.input;
  const list: string[] = typeof input == 'string' ? [input] : Array.isArray(input) ? input : input ? Object.values(input) : [];
  return new Set([...list, ...extra].filter((x) => !/\.html?$/i.test(x)).map((x) => norm(resolvePath(config.root, x))));
}

/** The Vite plugin. Returns the dev plugin, the optional call-site transform and the build alias. */
export function gaze(options: GazeViteOptions = {}): Plugin[] {
  const o = { inject: true, bridge: true, viteErrors: true, noopInBuild: true, ...options };
  const plugins: Plugin[] = [];
  let config: ResolvedConfig;
  let entries = new Set<string>();
  let devServer = '';
  let client: Client | undefined;
  let forwarder: Forwarder | undefined;

  const target = (): Client => {
    if (!client) {
      client = new Client({ ...node, onExit: undefined });
      const { host, port, url, wire, token, enabled } = o;
      client.configure({ ...envDefaults(), ...{ host, port, url, wire, token, enabled } });
      forwarder = new Forwarder(client);
    }
    return client;
  };

  plugins.push({
    name: 'gaze',
    apply: o.apply ?? 'serve',
    configResolved(c) {
      config = c;
      entries = inputs(c, o.entries);
    },
    configureServer(server: ViteDevServer) {
      const c = target();
      if (!c.cfg.enabled) return;
      const log = server.config.logger;
      server.httpServer?.once('listening', () => {
        devServer = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? '';
      });
      void handshake(c).then((msg) => log.info(`  gaze: ${msg}`, { timestamp: true }));
      const toSource = sourceMapper(server);
      let last: Promise<unknown> = Promise.resolve();
      server.ws.on('gaze:batch', (data: { p?: string; b?: string }) => {
        const b = data?.b;
        if (typeof b != 'string') return;
        // In arrival order. Native batches are mapped before Ray mode re-encodes them; Ray envelopes are not.
        last = last.then(() => (data.p == '/' ? forwarder!.push('/', b) : toSource(b).then((m) => forwarder!.batch(m)))).catch(() => {});
      });
      server.ws.on('gaze:lock', (data: { id?: string }, ws) => {
        if (typeof data?.id != 'string') return;
        void c.lock(data.id).then((state) => ws.send('gaze:lock', { id: data.id, state }));
      });
    },
    resolveId(id) {
      return id == VIRTUAL ? RESOLVED : undefined;
    },
    load(id) {
      if (id != RESOLVED) return;
      const c = target();
      const name = o.project ?? config.root.replace(/\\/g, '/').split('/').filter(Boolean).pop();
      const project = { name, root: config.root.replace(/\\/g, '/'), dev_server: devServer || undefined };
      const cfg: Options = { project };
      if (!o.bridge) Object.assign(cfg, { host: c.cfg.host, port: c.cfg.port, url: c.cfg.url, wire: c.cfg.wire });
      if (o.enabled === false) cfg.enabled = false;
      const capture = o.capture ? (o.capture === true ? '' : JSON.stringify(o.capture)) : null;
      return [
        `import { ray } from ${JSON.stringify(PKG)};`,
        `const cfg = ${JSON.stringify(cfg)};`,
        `const hot = import.meta.hot;`,
        o.bridge
          ? `if (hot) {
  const waits = new Map();
  hot.on('gaze:lock', (d) => { const w = waits.get(d.id); if (w) { waits.delete(d.id); w(d.state); } });
  cfg.bridge = {
    post: (p, b) => hot.send('gaze:batch', { p, b }),
    lock: (id) => new Promise((r) => { waits.set(id, r); hot.send('gaze:lock', { id }); }),
  };
}`
          : '',
        `ray.configure(cfg);`,
        o.viteErrors
          ? `if (hot) hot.on('vite:error', ({ err }) => {
  const e = Object.assign(new Error(err.message), { name: 'ViteError', stack: err.stack });
  const l = err.loc;
  (l && l.file ? ray.at$(l.file, l.line || 1, (l.column || 0) + 1)() : ray()).exception(e, { plugin: err.plugin, id: err.id, frame: err.frame }).label('vite');
});`
          : '',
        capture !== null ? `ray.capture(${capture});` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
    transformIndexHtml: {
      order: 'pre',
      handler(): HtmlTagDescriptor[] {
        if (!o.inject || !target().cfg.enabled) return [];
        return [{ tag: 'script', attrs: { type: 'module', src: `${config.base}@id/${VIRTUAL}` }, injectTo: 'head-prepend' }];
      },
    },
    transform(code, id) {
      if (!o.inject || !entries.size || !entries.has(norm(id)) || !target().cfg.enabled) return;
      return applyEdits(code, [{ start: 0, end: 0, text: `import ${JSON.stringify(VIRTUAL)};` }], id.replace(/[?#].*$/, ''));
    },
  });

  if (o.callSites) {
    let parse: ParseFn | undefined;
    plugins.push({
      name: 'gaze:call-sites',
      apply: o.apply ?? 'serve',
      enforce: 'pre',
      async transform(code, id) {
        if (!code.includes(PKG) || !target().cfg.enabled) return;
        parse ??= ((await import('vite')) as unknown as { parseAst: ParseFn }).parseAst;
        return transformCallSites(code, id, parse);
      },
    });
  }

  if (o.noopInBuild)
    plugins.push({
      name: 'gaze:noop',
      apply: 'build',
      // The package and its side-effect ./auto entry; adapters keep working on top of the noop core.
      config: () => ({ resolve: { alias: [{ find: /^@thewonderjoy\/gaze-js(\/auto)?$/, replacement: PKG + '/noop' }] } }),
    });
  return plugins;
}

export default gaze;
export type { Wire };
