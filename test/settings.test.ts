// Settings and switches as the README and INTERNALS describe them: GAZE_CAPTURE and its global object,
// capture(options), the Node env settings, enabled/enable(), propagate and the Vite plugin options.
import { createServer as createHttp, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ResolvedConfig, type ViteDevServer } from 'vite';
import { autoOptions } from '../src/capture.js';
import { install as installNode } from '../src/capture-node.js';
import { envDefaults } from '../src/platform/node.js';
import gaze, { type GazeViteOptions } from '../src/vite.js';
import { makeRay, settle } from './helpers.js';

const G = globalThis as Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` with these env vars set (undefined deletes one), then puts the env back. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const keep = { ...process.env };
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
}

describe('GAZE_CAPTURE picks the /auto capture parts', () => {
  const all = { console: true, errors: true, network: true, requests: true, queries: true };
  afterEach(() => {
    delete G.GAZE_CAPTURE;
  });

  it('unset or empty: every part (no options)', async () => {
    await withEnv({ GAZE_CAPTURE: undefined }, () => expect(autoOptions()).toBeUndefined());
    await withEnv({ GAZE_CAPTURE: '' }, () => expect(autoOptions()).toBeUndefined());
  });

  it('a list turns on only the parts it names; the rest are off', async () => {
    const cases: [string, string[]][] = [
      ['errors', ['errors']],
      ['console,network', ['console', 'network']],
      ['console, network', ['console', 'network']],
      ['requests queries', ['requests', 'queries']],
      ['errors,bogus', ['errors']],
      ['console,errors,network,requests,queries', Object.keys(all)],
    ];
    for (const [env, on] of cases) {
      const want = Object.fromEntries(Object.keys(all).map((k) => [k, on.includes(k)]));
      await withEnv({ GAZE_CAPTURE: env }, () => expect(autoOptions(), env).toEqual(want));
    }
  });

  it('globalThis.GAZE_CAPTURE turns off only the keys set to false, and wins over the env list', async () => {
    G.GAZE_CAPTURE = { console: false };
    expect(autoOptions()).toEqual({ ...all, console: false });
    G.GAZE_CAPTURE = {};
    expect(autoOptions()).toEqual(all);
    G.GAZE_CAPTURE = { network: false, queries: false };
    await withEnv({ GAZE_CAPTURE: 'network' }, () => expect(autoOptions()).toEqual({ ...all, network: false, queries: false }));
  });
});

describe('capture(options) installs only the parts set to true', () => {
  const snapshot = () => ({ log: console.log, fetch: G.fetch, warnings: process.listenerCount('warning') });

  async function installed(options?: Parameters<ReturnType<typeof makeRay>['ray']['capture']>[0]) {
    const { ray } = makeRay();
    const before = snapshot();
    const undo = await ray.capture(options);
    const during = snapshot();
    undo();
    expect(snapshot(), 'uninstall restores everything').toEqual(before);
    return {
      console: during.log !== before.log,
      network: during.fetch !== before.fetch,
      errors: during.warnings > before.warnings,
    };
  }

  it('no options: console, errors and network', async () => {
    expect(await installed()).toEqual({ console: true, errors: true, network: true });
  });

  it('{ network: true }: network only', async () => {
    expect(await installed({ network: true })).toEqual({ console: false, errors: false, network: true });
  });

  it('{ console: true, errors: true }: those two', async () => {
    expect(await installed({ console: true, errors: true })).toEqual({ console: true, errors: true, network: false });
  });

  it('{} and { console: false }: nothing', async () => {
    expect(await installed({})).toEqual({ console: false, errors: false, network: false });
    expect(await installed({ console: false })).toEqual({ console: false, errors: false, network: false });
  });

  it('while disabled: nothing', async () => {
    const { ray } = makeRay();
    ray.configure({ enabled: false });
    const before = snapshot();
    const undo = await ray.capture();
    expect(snapshot()).toEqual(before);
    undo();
  });
});

describe('Node: GAZE_SLOW_QUERY_MS reaches query capture', () => {
  const pgjs = async () => (await import('node:diagnostics_channel')).tracingChannel('postgres:query');

  /** Installs Node query capture with this env, runs a fast and a slow query, returns their flags. */
  async function flags(env: string | undefined, slowMs: number): Promise<[string[], string[]]> {
    return withEnv({ GAZE_SLOW_QUERY_MS: env }, async () => {
      const { ray, entries } = makeRay();
      const undo = installNode(ray, { queries: true });
      try {
        const ch = await pgjs();
        await ch.tracePromise(async () => sleep(0), { query: 'select 1', parameters: [] });
        await ch.tracePromise(async () => sleep(slowMs), { query: 'select 2', parameters: [] });
        await ray.flush();
      } finally {
        undo();
      }
      const qs = entries().filter((e) => e.kind == 'query');
      const of = (sql: string) => (qs.find((e) => e.body!.sql == sql)?.body!.flags as string[] | undefined) ?? ['missing'];
      return [of('select 1'), of('select 2')];
    });
  }

  it('unset: 100 ms', async () => {
    expect(await flags(undefined, 130)).toEqual([[], ['slow']]);
  });

  it('GAZE_SLOW_QUERY_MS=40', async () => {
    expect(await flags('40', 70)).toEqual([[], ['slow']]);
  });

  it('GAZE_SLOW_QUERY_MS=500: a 130 ms query is not slow', async () => {
    expect(await flags('500', 130)).toEqual([[], []]);
  });

  it('GAZE_SLOW_QUERY_MS=0: every query is slow', async () => {
    expect(await flags('0', 0)).toEqual([['slow'], ['slow']]);
  });

  it('an invalid value keeps 100 ms', async () => {
    expect(await flags('abc', 130)).toEqual([[], ['slow']]);
  });

  it('Node capture installs only the parts asked for', async () => {
    const { ray } = makeRay();
    const log = console.log;
    const undo = installNode(ray, { queries: true });
    expect(console.log).toBe(log);
    undo();
  });
});

describe('Node env settings', () => {
  const clean = { GAZE_HOST: undefined, GAZE_PORT: undefined, RAY_HOST: undefined, RAY_PORT: undefined, GAZE_ENABLED: undefined, NODE_ENV: undefined, GAZE_WIRE: undefined, GAZE_TOKEN: undefined };

  it('GAZE_ENABLED: 0, false, off and no (any case) turn it off; anything else turns it on, even in production', async () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
      await withEnv({ ...clean, GAZE_ENABLED: v }, () => expect(envDefaults().enabled, v).toBe(false));
    }
    for (const v of ['1', 'true', 'yes', 'on']) {
      await withEnv({ ...clean, GAZE_ENABLED: v, NODE_ENV: 'production' }, () => expect(envDefaults().enabled, v).toBe(true));
    }
    await withEnv({ ...clean, NODE_ENV: 'development' }, () => expect(envDefaults().enabled).toBeUndefined());
  });

  it('GAZE_TOKEN', async () => {
    await withEnv({ ...clean, GAZE_TOKEN: 's3cret' }, () => expect(envDefaults()).toEqual({ token: 's3cret' }));
  });

  it('GAZE_WIRE: native, ray and auto; other values are ignored', async () => {
    for (const v of ['native', 'ray', 'auto']) await withEnv({ ...clean, GAZE_WIRE: v }, () => expect(envDefaults().wire).toBe(v));
    for (const v of ['bogus', 'RAY']) await withEnv({ ...clean, GAZE_WIRE: v }, () => expect(envDefaults().wire, v).toBeUndefined());
  });

  it('GAZE_PORT: 0, negative or not a number leaves the default', async () => {
    for (const v of ['0', '-1', 'abc']) await withEnv({ ...clean, GAZE_PORT: v }, () => expect(envDefaults().port, v).toBeUndefined());
  });
});

describe('enabled: false pauses sending until enable()', () => {
  it('configure({ enabled: false }), then enable(): the entries sent before still arrive, as with disable()', async () => {
    for (const pause of ['disable', 'configure'] as const) {
      const { ray, entries } = makeRay();
      ray('before');
      if (pause == 'disable') ray.disable();
      else ray.configure({ enabled: false });
      ray('while paused');
      ray.enable();
      ray('after');
      await ray.flush();
      const sent = entries().map((e) => JSON.stringify(e.body));
      expect(sent.some((s) => s.includes('before')), `${pause}: before`).toBe(true);
      expect(sent.some((s) => s.includes('while paused')), `${pause}: while paused`).toBe(false);
      expect(sent.some((s) => s.includes('after')), `${pause}: after`).toBe(true);
    }
  });
});

describe('propagate: the origins whose requests get a traceparent', () => {
  let calls: { url: string; traceparent: string | null }[];
  let orig: typeof fetch;
  beforeEach(() => {
    calls = [];
    orig = G.fetch;
    G.fetch = async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), traceparent: new Headers(init?.headers).get('traceparent') });
      return new Response('ok');
    };
  });
  afterEach(() => {
    G.fetch = orig;
  });

  it('listed origins (trailing slash or not), loopback and *.test get one; other hosts do not', async () => {
    const { ray } = makeRay();
    ray.configure({ propagate: ['https://api.example.com/', 'https://pay.example.com'] });
    const undo = await ray.capture({ network: true });
    try {
      for (const url of [
        'https://api.example.com/orders',
        'https://pay.example.com/x',
        'http://127.0.0.1:8000/a',
        'http://shop.test/b',
        'https://other.example.com/c',
        'https://api.example.com:8443/d',
      ])
        await G.fetch(url);
    } finally {
      undo();
    }
    const has = Object.fromEntries(calls.map((c) => [c.url, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(c.traceparent ?? '')]));
    expect(has).toEqual({
      'https://api.example.com/orders': true,
      'https://pay.example.com/x': true,
      'http://127.0.0.1:8000/a': true,
      'http://shop.test/b': true,
      'https://other.example.com/c': false,
      'https://api.example.com:8443/d': false,
    });
  });

  it('a traceparent the app set is left alone', async () => {
    const { ray } = makeRay();
    const undo = await ray.capture({ network: true });
    const mine = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    try {
      await G.fetch('http://127.0.0.1:8000/a', { headers: { traceparent: mine } });
    } finally {
      undo();
    }
    expect(calls[0]!.traceparent).toBe(mine);
  });
});

describe('Vite plugin options', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'gaze-vite-opts-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** The dev plugin's hooks, run the way Vite would, without a server. */
  function hooks(options: GazeViteOptions) {
    const p = gaze({ host: '127.0.0.1', port: 23999, ...options }).find((x) => x.name == 'gaze') as unknown as Record<string, any>;
    const config = { root, base: '/', build: { rollupOptions: { input: 'src/main.ts' } } } as unknown as ResolvedConfig;
    p.configResolved(config);
    const id = p.resolveId('virtual:gaze-client');
    return {
      client: () => String(p.load(id)),
      html: () => p.transformIndexHtml.handler() as unknown[],
      entry: () => p.transform('console.log(1)', join(root, 'src/main.ts').replace(/\\/g, '/')),
    };
  }

  it('capture: true, an object, false or left out', () => {
    expect(hooks({ capture: true }).client()).toContain('ray.capture();');
    expect(hooks({ capture: { network: true } }).client()).toContain('ray.capture({"network":true});');
    expect(hooks({ capture: false }).client()).not.toContain('ray.capture(');
    expect(hooks({}).client()).not.toContain('ray.capture(');
  });

  it('enabled: false (or GAZE_ENABLED=false) injects nothing', async () => {
    const off = hooks({ enabled: false });
    expect(off.html()).toEqual([]);
    expect(off.entry()).toBeUndefined();
    await withEnv({ GAZE_ENABLED: 'false' }, () => {
      const env = hooks({});
      expect(env.html()).toEqual([]);
      expect(env.entry()).toBeUndefined();
    });
  });

  it('inject: false adds no script tag and no entry import', () => {
    const h = hooks({ inject: false });
    expect(h.html()).toEqual([]);
    expect(h.entry()).toBeUndefined();
    const on = hooks({});
    expect(on.html()).toHaveLength(1);
    expect((on.entry() as { code: string }).code).toContain('import "virtual:gaze-client";');
  });

  it('bridge: false posts straight to the app; viteErrors: false skips compile errors', () => {
    const direct = hooks({ bridge: false, viteErrors: false }).client();
    expect(direct).not.toContain("hot.send('gaze:batch'");
    expect(direct).toContain('"host":"127.0.0.1","port":23999');
    expect(direct).not.toContain('vite:error');
    const bridged = hooks({}).client();
    expect(bridged).toContain("hot.send('gaze:batch'");
    expect(bridged).not.toContain('"port":23999');
    expect(bridged).toContain("hot.on('vite:error'");
  });

  it('project: the Vite root folder name by default', () => {
    const name = root.replace(/\\/g, '/').split('/').pop();
    expect(hooks({}).client()).toContain(`"project":{"name":"${name}"`);
    expect(hooks({ project: 'shop' }).client()).toContain('"project":{"name":"shop"');
  });
});

describe('Vite forwarder and the token', () => {
  let app: Server;
  let server: ViteDevServer | undefined;
  let root: string;
  const seen: { url: string; auth?: string }[] = [];

  beforeEach(async () => {
    seen.length = 0;
    app = createHttp((req: IncomingMessage, res) => {
      req.resume();
      req.on('end', () => {
        seen.push({ url: req.url!, auth: req.headers.authorization });
        if (req.url == '/v1/hello') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"v":1,"server":{"name":"mock","version":"1"}}');
        res.writeHead(202).end('{}');
      });
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    root = realpathSync(mkdtempSync(join(tmpdir(), 'gaze-vite-token-')));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.ts'), '');
  });
  afterEach(async () => {
    await server?.close();
    await new Promise((r) => app.close(r));
    rmSync(root, { recursive: true, force: true });
  });

  it('sends the token only to a non-loopback app, like the client does', async () => {
    const port = (app.address() as { port: number }).port;
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { port: 0, host: '127.0.0.1' },
      plugins: [gaze({ host: '127.0.0.1', port, token: 's3cret' })],
    });
    await server.listen();
    const vite = (server.httpServer!.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${vite}/?token=${(server.config as any).webSocketToken}`, 'vite-hmr');
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    const batch = JSON.stringify({ v: 1, client: { name: 'x', version: '1', runtime: 'browser' }, session: 'session-1', entries: [] });
    ws.send(JSON.stringify({ type: 'custom', event: 'gaze:batch', data: { p: '/v1/batch', b: batch } }));
    for (let i = 0; i < 150 && !seen.some((r) => r.url == '/v1/batch'); i++) await settle(20);
    ws.close();
    const post = seen.find((r) => r.url == '/v1/batch');
    expect(post, 'the batch reached the app').toBeDefined();
    expect(post!.auth).toBeUndefined();
  });
});
