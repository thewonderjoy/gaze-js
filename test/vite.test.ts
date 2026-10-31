import { createServer as createHttp, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst, createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyEdits, gaze, transformCallSites } from '../src/vite.js';

const SRC = fileURLToPath(new URL('../src/browser.ts', import.meta.url));

// Minimal source-map decoder: [genLine, genCol] -> [srcLine, srcCol] (0-based).
function decode(mappings: string): Map<string, [number, number]> {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out = new Map<string, [number, number]>();
  let sl = 0;
  let sc = 0;
  mappings.split(';').forEach((line, gl) => {
    let gc = 0;
    for (const seg of line.split(',').filter(Boolean)) {
      const nums: number[] = [];
      let v = 0;
      let shift = 0;
      for (const ch of seg) {
        const d = B64.indexOf(ch);
        v += (d & 31) << shift;
        if (d & 32) shift += 5;
        else {
          nums.push(v & 1 ? -(v >>> 1) : v >>> 1);
          v = shift = 0;
        }
      }
      gc += nums[0]!;
      sl += nums[2]!;
      sc += nums[3]!;
      out.set(`${gl}:${gc}`, [sl, sc]);
    }
  });
  return out;
}

describe('applyEdits (source maps for small edits)', () => {
  it('maps code after an edit back to its original column', () => {
    const code = 'a(1); ray(2); b(3);\nnext(ray(4));\n';
    const edits = [
      { start: 6, end: 9, text: 'XXXXXXXX' },
      { start: 25, end: 28, text: 'YY' },
    ];
    const { code: out, map } = applyEdits(code, edits, '/f.ts');
    expect(out).toBe('a(1); XXXXXXXX(2); b(3);\nnext(YY(4));\n');
    const m = decode((map as any).mappings);
    expect(m.get('0:0')).toEqual([0, 0]);
    expect(m.get('0:6')).toEqual([0, 6]); // edit start
    expect(m.get('0:14')).toEqual([0, 9]); // "(2)" after the replacement
    expect(m.get('1:5')).toEqual([1, 5]);
    expect(m.get('1:7')).toEqual([1, 8]);
    expect(out.indexOf('b(3)')).toBe(19); // shifted by 5 in the output, still mapped to col 14 via the last segment
  });

  it('a prepend at 0:0 keeps every other line identical', () => {
    const { code, map } = applyEdits('x\ny\n', [{ start: 0, end: 0, text: 'import "v";' }], '/f.ts');
    expect(code).toBe('import "v";x\ny\n');
    const m = decode((map as any).mappings);
    expect(m.get('0:11')).toEqual([0, 0]);
    expect(m.get('1:0')).toEqual([1, 0]);
  });
});

describe('call-site transform (AST, Vite 8 parseAst)', () => {
  const parse = parseAst as any;

  it('rewrites only calls of the imported names; strings, comments, members untouched', () => {
    const code = [
      "import { ray as r, gaze } from '@thewonderjoy/gaze-js';",
      'const é: number = 1; r("a");',
      'obj.r("member"); const s = "r(\'in string\')"; // r("comment")',
      '  gaze().text(`t ${r(1)}`);',
      'function shadow(r: Function) { return r(2); }',
    ].join('\n');
    const out = transformCallSites(code, '/abs/src/x.ts?t=1', parse)!;
    const lines = out.code.split('\n');
    expect(lines[1]).toBe('const é: number = 1; (r.at$?r.at$("/abs/src/x.ts",2,22):r)("a");');
    expect(lines[2]).toBe('obj.r("member"); const s = "r(\'in string\')"; // r("comment")');
    expect(lines[3]).toBe('  (gaze.at$?gaze.at$("/abs/src/x.ts",4,3):gaze)().text(`t ${(r.at$?r.at$("/abs/src/x.ts",4,20):r)(1)}`);');
    // a shadowing local is also rewritten, but the guard falls back to the plain call at runtime
    expect(lines[4]).toContain('(r.at$?r.at$("/abs/src/x.ts",5,39):r)(2)');
    const local = (n: number) => n * 2;
    expect((((local as any).at$ ? 0 : local) as any)(2)).toBe(4);
  });

  it('handles TSX/JSX with quotes in JSX text', () => {
    const code = "import ray from '@thewonderjoy/gaze-js';\nexport const A = () => <p onClick={() => ray('x')}>don't</p>;\n";
    const out = transformCallSites(code, '/abs/A.tsx', parse)!;
    expect(out.code).toContain('(ray.at$?ray.at$("/abs/A.tsx",2,42):ray)(\'x\')');
    expect(out.code).toContain("don't");
  });

  it('only touches <script> blocks of .vue/.svelte files (positions are SFC lines)', () => {
    const code = [
      '<template>',
      '  <button @click="ray(1)">x</button>',
      '</template>',
      '<script setup lang="ts">',
      "import { ray } from '@thewonderjoy/gaze-js';",
      "const n: number = 1; ray('setup');",
      '</script>',
    ].join('\n');
    const out = transformCallSites(code, '/abs/App.vue', parse)!;
    expect(out.code.split('\n')[1]).toBe('  <button @click="ray(1)">x</button>');
    expect(out.code.split('\n')[5]).toBe('const n: number = 1; (ray.at$?ray.at$("/abs/App.vue",6,22):ray)(\'setup\');');
  });

  it('leaves files alone that do not import the package, do not parse, or live in node_modules', () => {
    expect(transformCallSites("ray('x')", '/abs/a.ts', parse)).toBeNull();
    expect(transformCallSites("import { ray } from '@thewonderjoy/gaze-js'; ray(", '/abs/a.ts', parse)).toBeNull();
    expect(transformCallSites("import { ray } from '@thewonderjoy/gaze-js'; ray(1)", '/x/node_modules/p/a.js', parse)).toBeNull();
  });
});

describe('build alias', () => {
  it('aliases the package to ./noop in vite build only', () => {
    const plugins = gaze();
    const build = plugins.find((p) => p.name == 'gaze:noop')!;
    expect(build.apply).toBe('build');
    const cfg = (build.config as any)();
    expect(cfg.resolve.alias[0].find.test('@thewonderjoy/gaze-js')).toBe(true);
    expect(cfg.resolve.alias[0].find.test('@thewonderjoy/gaze-js/auto')).toBe(true);
    expect(cfg.resolve.alias[0].find.test('@thewonderjoy/gaze-js/vue')).toBe(false);
    expect(cfg.resolve.alias[0].replacement).toBe('@thewonderjoy/gaze-js/noop');
    expect(plugins.find((p) => p.name == 'gaze')!.apply).toBe('serve');
    expect(plugins.some((p) => p.name == 'gaze:call-sites')).toBe(false);
    expect(gaze({ callSites: true }).some((p) => p.name == 'gaze:call-sites')).toBe(true);
  });
});

describe('dev server: injection, HMR bridge, lock relay, handshake', () => {
  let app: Server;
  let appPort = 0;
  const appRequests: { method: string; url: string; body: string; ua?: string }[] = [];
  let server: ViteDevServer;
  let root: string;
  const logs: string[] = [];

  beforeAll(async () => {
    app = createHttp((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        appRequests.push({ method: req.method!, url: req.url!, body, ua: req.headers['user-agent'] });
        if (req.url == '/v1/hello') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ v: 1, server: { name: 'mock', version: '9' } }));
        if (req.url?.startsWith('/v1/locks/')) return res.writeHead(200).end('{"state":"released"}');
        res.writeHead(202).end('{"accepted":1}');
      });
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    appPort = (app.address() as { port: number }).port;

    root = mkdtempSync(join(tmpdir(), 'gaze-vite-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.ts'), "console.log('app');\n");
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'info',
      customLogger: {
        info: (m: string) => logs.push(m),
        warn: () => {},
        warnOnce: () => {},
        error: () => {},
        clearScreen: () => {},
        hasErrorLogged: () => false,
        hasWarned: false,
      },
      resolve: { alias: [{ find: /^@thewonderjoy\/gaze-js$/, replacement: SRC }] },
      server: { port: 0, host: '127.0.0.1', strictPort: false },
      build: { rollupOptions: { input: 'src/main.ts' } },
      plugins: [gaze({ host: '127.0.0.1', port: appPort, project: 'demo', capture: { errors: true } })],
    });
    await server.listen();
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await new Promise((r) => app?.close(r));
    rmSync(root, { recursive: true, force: true });
  });

  it('handshakes with GET /v1/hello and logs the result', async () => {
    for (let i = 0; i < 50 && !logs.some((l) => l.includes('gaze:')); i++) await new Promise((r) => setTimeout(r, 20));
    expect(appRequests[0]).toMatchObject({ method: 'GET', url: '/v1/hello' });
    expect(logs.find((l) => l.includes('gaze:'))).toContain('connected to mock 9');
  });

  it('injects the client into index.html and into build-input entry modules', async () => {
    const html = await server.transformIndexHtml('/index.html', '<!doctype html><html><head></head><body></body></html>');
    expect(html).toMatch(/<script type="module" src="\/@id\/virtual:gaze-client"><\/script>/);
    const base = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
    const entry = await (await fetch(base + '/src/main.ts')).text();
    expect(entry.startsWith('import "/@id/__x00__virtual:gaze-client";')).toBe(true);
    const client = await (await fetch(base + '/@id/virtual:gaze-client')).text();
    expect(client).toContain("hot.send('gaze:batch'");
    expect(client).toContain('"project":{"name":"demo","root":');
    expect(client).toContain('ray.capture({"errors":true})');
    expect(client).toContain("hot.on('vite:error'");
    expect(client).toMatch(/import \{ ray \} from "\/@fs\/.*\/src\/browser\.ts"/);
  });

  it('forwards gaze:batch from the HMR socket to POST /v1/batch and relays locks back', async () => {
    const port = (server.httpServer!.address() as { port: number }).port;
    const token = (server.config as any).webSocketToken;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, 'vite-hmr');
    const inbox: any[] = [];
    ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    const batch = JSON.stringify({ v: 1, client: { name: 'x', version: '1', runtime: 'browser' }, session: 'session-1', entries: [] });
    ws.send(JSON.stringify({ type: 'custom', event: 'gaze:batch', data: { p: '/v1/batch', b: batch } }));
    ws.send(JSON.stringify({ type: 'custom', event: 'gaze:lock', data: { id: 'lock-0001' } }));
    for (let i = 0; i < 100 && !inbox.some((m) => m.event == 'gaze:lock'); i++) await new Promise((r) => setTimeout(r, 20));
    ws.close();
    expect(appRequests.find((r) => r.url == '/v1/batch')).toMatchObject({ method: 'POST', body: batch, ua: 'gaze-js/0.1.0' });
    expect(appRequests.find((r) => r.url?.startsWith('/v1/locks/'))!.url).toBe('/v1/locks/lock-0001?wait=25');
    expect(inbox.find((m) => m.event == 'gaze:lock')).toMatchObject({ type: 'custom', data: { id: 'lock-0001', state: 'released' } });
  });
});
