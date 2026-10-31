// End-to-end against the real Gaze core: target/debug/gaze-serve --port 23620 --json prints one JSON
// frame per store change ({add, patch, del, cmds, locks, sources, ...}). The client under test sends
// over real HTTP in both wire modes; we fold the frames into entries and assert kinds, titles, values,
// modifiers and origins. The server is stopped with "q" on stdin (killed as a fallback).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRay, type RayFn } from '../../src/core/ray.js';
import { node } from '../../src/platform/node.js';
import { lineOf } from '../helpers.js';
import { pkg, repo } from './setup.js';

const PORT = 23620;
const FILE = fileURLToPath(import.meta.url);
const EXE = `${process.env.CARGO_TARGET_DIR ?? repo + 'target'}/debug/gaze-serve${process.platform == 'win32' ? '.exe' : ''}`;

interface Entry {
  id: string;
  key: string;
  kind: string;
  title: string;
  label: string | null;
  color: string | null;
  size: string | null;
  hidden: boolean;
  sourceId: string;
  traceId: string | null;
  origin: { file: string; line: number | null; col: number | null; function: string | null } | null;
  body: any;
}

class GazeServe {
  proc!: ChildProcess;
  entries = new Map<string, Entry>();
  sources = new Map<string, any>();
  cmds: any[] = [];
  locks: any[] = [];
  stderr = '';
  exited = false;

  async start(): Promise<void> {
    if (!existsSync(EXE)) throw new Error(`missing ${EXE} (cargo build failed?)`);
    this.proc = spawn(EXE, ['--port', String(PORT), '--json'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('exit', () => (this.exited = true));
    let buf = '';
    this.proc.stdout!.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.apply(JSON.parse(line));
      }
    });
    this.proc.stderr!.on('data', (d) => (this.stderr += d));
    await this.until(() => this.stderr.includes('listening on') || this.exited, 30_000);
    if (this.exited) throw new Error(`gaze-serve exited: ${this.stderr}`);
  }

  apply(f: any): void {
    if (f.cleared) this.entries.clear();
    for (const s of f.sources ?? []) this.sources.set(s.id, s);
    for (const e of f.add ?? []) this.entries.set(e.id, e);
    for (const p of f.patch ?? []) {
      const e = this.entries.get(p.id);
      if (e) Object.assign(e, p);
    }
    for (const id of f.del ?? []) this.entries.delete(id);
    this.cmds.push(...(f.cmds ?? []));
    this.locks.push(...(f.locks ?? []));
  }

  byKey(key: string): Entry | undefined {
    return [...this.entries.values()].find((e) => e.key == key);
  }
  find(pred: (e: Entry) => boolean): Entry | undefined {
    return [...this.entries.values()].find(pred);
  }
  all(project: string): Entry[] {
    return [...this.entries.values()].filter((e) => this.sources.get(e.sourceId)?.project == project);
  }

  async until(pred: () => boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timeout; stderr:\n${this.stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  command(line: string): void {
    this.proc.stdin!.write(line + '\n');
  }

  async stop(): Promise<void> {
    if (!this.proc || this.exited) return;
    this.command('q');
    try {
      await this.until(() => this.exited, 5000);
    } catch {
      this.proc.kill();
      if (process.platform == 'win32' && this.proc.pid) spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F']);
    }
  }
}

const server = new GazeServe();
const loaders = { capture: () => import('../../src/capture.js'), ray: () => import('../../src/core/ray-wire.js').then((m) => m.rayEnvelope) };
const fresh = (project: string, wire: 'native' | 'ray'): RayFn => {
  const r = createRay({ ...node, onExit: undefined, defaults: () => ({}) }, loaders);
  r.configure({ host: '127.0.0.1', port: PORT, project, wire });
  return r;
};

/** Run a fixture with `node` and wait for it to exit by itself. */
function runNode(file: string, env: Record<string, string>, args: string[] = []): Promise<{ code: number | null; ms: number; out: string }> {
  const t0 = Date.now();
  const clean = { ...process.env };
  for (const k of ['GAZE_HOST', 'GAZE_PORT', 'RAY_HOST', 'RAY_PORT', 'GAZE_ENABLED', 'NODE_ENV', 'GAZE_WIRE']) delete clean[k];
  const p = spawn(process.execPath, [...args, file], { cwd: pkg, env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout!.on('data', (d) => (out += d));
  p.stderr!.on('data', (d) => (out += d));
  return new Promise((resolve, reject) => {
    const kill = setTimeout(() => (p.kill(), reject(new Error(`${file} did not exit: ${out}`))), 20_000);
    p.on('exit', (code) => (clearTimeout(kill), resolve({ code, ms: Date.now() - t0, out })));
  });
}

beforeAll(async () => {
  await server.start();
});
afterAll(async () => {
  await server.stop();
});

describe('e2e: native protocol (POST /v1/batch)', () => {
  it('delivers every kind with titles, values, modifiers and exact origins', async () => {
    const ray = fresh('e2e-native', 'native');
    ray('hello e2e', { a: 1, list: [1, 2] }, 3.5, null).blue().label('L1').large(); // @n-log
    ray().text('plain  text\nline 2');
    ray().html('<b>bold</b> html');
    ray().markdown('# Title');
    ray().mermaid('graph TD; A-->B');
    ray().table({ First: 'a', Second: 2 }, 'My table');
    ray().table([{ id: 1, name: 'x' }]);
    ray().json('{"x":1}');
    ray().toJson({ y: [1, 2] });
    ray().exception(new TypeError('bad thing', { cause: new Error('root cause') }), { orderId: 7 }); // @n-exception
    ray().trace(3);
    ray().measure('lap');
    ray().measure('lap');
    ray().date(new Date(2026, 9, 31, 12, 0, 0));
    ray().image('https://example.test/a.png');
    ray().separator();
    for (let i = 0; i < 3; i++) ray().count('loop');
    ray().newScreen('E2E screen');
    ray().notify('e2e note');
    ray().entry('http', { method: 'GET', url: '/api/x', status: 404, duration_ms: 12.5 });
    ray.group('checkout', () => ray('inside group'));
    await ray.flush();
    const upd = ray('to update');
    const gone = ray('to remove');
    ray.at('e2e-fixed-id').send('v1');
    await ray.flush();
    upd.send('updated').red();
    gone.remove();
    ray.at('e2e-fixed-id').send('v2').hide();
    ray.at('e2e-fixed-id').append('v3');
    await ray.flush();

    // Wait for the flush's last op too (the append makes the title 'v2 v3'). Ops apply in order, so the
    // hide() before it is in by then. Waiting only for 'updated' read the fixed entry too early on slow CI.
    await server.until(
      () => !!server.find((e) => e.title == 'updated') && !server.find((e) => e.title == 'to remove') && server.byKey('e2e-fixed-id')?.title == 'v2 v3',
    );
    // 22 entries: 'to update' became 'updated', 'to remove' is gone, the fixed id is one entry.
    await server.until(() => server.all('e2e-native').length >= 22).catch((e) => {
      throw new Error(`${e.message}\n${server.all('e2e-native').map((x) => `${x.kind} ${x.title}`).join('\n')}`);
    });
    const get = (title: string) => server.all('e2e-native').find((e) => e.title == title);

    const log = server.all('e2e-native').find((e) => e.title.startsWith('hello e2e'))!;
    expect(log).toMatchObject({ kind: 'log', label: 'L1', color: 'blue', size: 'lg' });
    expect(log.title).toBe('hello e2e Object {a: 1, list: [1, 2]} 3.5 null');
    expect(log.body.values[1]).toMatchObject({ k: 'obj', cls: 'Object' });
    expect(log.origin!.file.replace(/\\/g, '/').toLowerCase()).toBe(FILE.replace(/\\/g, '/').toLowerCase());
    expect(log.origin!.line).toBe(lineOf(FILE, '@n-log'));
    expect(log.origin!.col).toBe(5);

    expect(get('plain  text\nline 2') ?? server.find((e) => e.kind == 'text' && e.body.text.startsWith('plain'))).toMatchObject({ kind: 'text', body: { text: 'plain  text\nline 2' } });
    expect(server.find((e) => e.kind == 'html')).toMatchObject({ body: { html: '<b>bold</b> html' } });
    expect(get('# Title')).toMatchObject({ kind: 'markdown' });
    expect(get('graph TD; A-->B')).toMatchObject({ kind: 'mermaid' });
    expect(server.find((e) => e.kind == 'table' && e.body.label == 'My table')!.title).toBe('My table: First=a, Second=2');
    expect(server.find((e) => e.kind == 'table' && e.body.label == '')!.body.rows[0][1]).toMatchObject({ k: 'map' });
    expect(server.all('e2e-native').filter((e) => e.kind == 'json').map((e) => e.title)).toEqual(['Object {x: 1}', 'Object {y: [1, 2]}']);
    const ex = get('TypeError: bad thing')!;
    expect(ex).toMatchObject({ kind: 'exception', color: 'red' });
    expect(ex.body.frames[0].line).toBe(lineOf(FILE, '@n-exception'));
    expect(ex.body.meta.props.map((p: any) => p.n)).toEqual(['cause', 'orderId']);
    expect(server.find((e) => e.kind == 'trace' && e.sourceId == log.sourceId)!.title).toMatch(/^trace \(3 frames\) .*gaze-serve\.test\.ts/);
    const laps = server.all('e2e-native').filter((e) => e.kind == 'measure');
    expect(laps.map((e) => e.title)[0]).toBe('lap: started');
    expect(laps[1]!.title).toMatch(/^lap: [\d.]+ ms$/);
    expect(laps[1]!.body.memPeak).toBeGreaterThan(0);
    expect(get('2026-10-31 12:00:00 (' + Intl.DateTimeFormat().resolvedOptions().timeZone + ')')).toMatchObject({ kind: 'date' });
    expect(get('https://example.test/a.png')).toMatchObject({ kind: 'image' });
    expect(server.find((e) => e.kind == 'separator' && e.sourceId == log.sourceId)).toBeTruthy();
    expect(get('Called `loop` 3 times.')).toMatchObject({ kind: 'log' });
    expect(get('GET /api/x 404')).toMatchObject({ kind: 'http' });
    expect(server.cmds).toEqual(expect.arrayContaining([expect.objectContaining({ cmd: 'new_screen', name: 'E2E screen' }), expect.objectContaining({ cmd: 'notify', text: 'e2e note' })]));
    const inside = get('inside group')!;
    expect(inside.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(get('checkout')).toMatchObject({ kind: 'group', traceId: inside.traceId });
    expect(get('updated')).toMatchObject({ color: 'red' });
    expect(get('to update')).toBeUndefined();
    const fixed = server.byKey('e2e-fixed-id')!;
    expect(fixed).toMatchObject({ hidden: true });
    expect(fixed.title).toBe('v2 v3'); // update replaced v1; the append added v3 as an iteration
    const src = server.sources.get(log.sourceId);
    expect(src).toMatchObject({ project: 'e2e-native', runtime: 'node', client: '@thewonderjoy/gaze-js 0.1.0', via: 'native' });
  });

  it('pause() waits for Continue / Stop in the app (GET /v1/locks/{id}?wait=25)', async () => {
    const ray = fresh('e2e-native', 'native');
    const first = ray().pause();
    await server.until(() => server.locks.some((l) => l.state == 'active'));
    server.command('c');
    await expect(first).resolves.toBe('released');
    const n = server.locks.length;
    const second = ray().pause();
    await server.until(() => server.locks.slice(n).some((l) => l.state == 'active'));
    server.command('s');
    await expect(second).resolves.toBe('stopped');
  });
});

describe('e2e: Ray-compat wire (POST /, Spatie Ray v1 envelopes)', () => {
  it('delivers the same calls through the Ray endpoint', async () => {
    const ray = fresh('e2e-ray', 'ray');
    ray('ray hello', 42, true, { deep: { x: 1 } }).purple().label('R1'); // @r-log
    ray().text('a <b>  c\nd');
    ray().html('<i>italic</i>');
    ray().markdown('**md**');
    ray().mermaid('graph LR; X-->Y');
    ray().table({ k: 'v', n: 1 }, 'Ray table');
    ray().toJson({ z: 1 });
    ray().exception(new RangeError('ray bad'));
    ray().trace(2);
    ray().measure('rlap');
    ray().date(new Date(2026, 0, 2, 3, 4, 5));
    ray().image('https://example.test/r.png');
    ray().separator();
    ray().newScreen('Ray screen');
    ray().notify('ray note');
    await ray.flush();
    const r2 = ray('ray before');
    await ray.flush();
    r2.send('ray after').small();
    await ray.flush();

    await server.until(() => server.all('e2e-ray').length >= 14 && !!server.find((e) => e.title == 'ray after'));
    const all = server.all('e2e-ray');
    const get = (t: string) => all.find((e) => e.title == t);
    const log = all.find((e) => e.label == 'R1')!;
    expect(log).toMatchObject({ kind: 'log', color: 'purple' });
    expect(log.title).toContain('ray hello 42 true');
    expect(log.origin!.line).toBe(lineOf(FILE, '@r-log'));
    expect(log.origin!.file.replace(/\\/g, '/').toLowerCase()).toBe(FILE.replace(/\\/g, '/').toLowerCase());
    // the json_string payload of the same envelope is a second content block of that entry (or its own row)
    expect(JSON.stringify(log.body).includes('deep') || all.some((e) => e.kind == 'json' && JSON.stringify(e.body).includes('deep'))).toBe(true);
    expect(all.find((e) => e.kind == 'text' && e.body.text.startsWith('a <b>'))!.body.text).toBe('a <b>  c\nd');
    expect(all.find((e) => e.kind == 'html')!.body.html).toBe('<i>italic</i>');
    expect(get('**md**')).toMatchObject({ kind: 'markdown' });
    expect(get('graph LR; X-->Y')).toMatchObject({ kind: 'mermaid' });
    expect(get('Ray table: k=v, n=1')).toMatchObject({ kind: 'table' });
    expect(get('{z: 1}')).toMatchObject({ kind: 'json' });
    expect(get('RangeError: ray bad')).toMatchObject({ kind: 'exception', color: 'red' });
    expect(all.find((e) => e.kind == 'trace')!.body.frames.length).toBe(2);
    expect(get('rlap: started')).toMatchObject({ kind: 'measure' });
    expect(all.find((e) => e.kind == 'date')!.title).toMatch(/^2026-01-02 03:04:05/);
    expect(get('https://example.test/r.png')).toMatchObject({ kind: 'image' });
    expect(all.some((e) => e.kind == 'separator')).toBe(true);
    expect(get('ray after')).toMatchObject({ size: 'sm' });
    expect(get('ray before')).toBeUndefined();
    expect(server.cmds).toEqual(expect.arrayContaining([expect.objectContaining({ cmd: 'new_screen', name: 'Ray screen' }), expect.objectContaining({ cmd: 'notify', text: 'ray note' })]));
    expect(server.sources.get(log.sourceId)).toMatchObject({ project: 'e2e-ray', via: 'ray' });
  });

  it('pause() over the Ray lock protocol (create_lock + GET /locks/{name})', async () => {
    const ray = fresh('e2e-ray', 'ray');
    const n = server.locks.length;
    const p = ray().pause();
    await server.until(() => server.locks.slice(n).some((l) => l.state == 'active'));
    server.command('c');
    await expect(p).resolves.toBe('released');
  });
});

describe('e2e: the built package in child processes', () => {
  it('ESM import of dist/node.js delivers without an explicit flush, then the process exits', async () => {
    const fixture = pkg + 'test/e2e/fixtures/dist-esm.mjs';
    const r = await runNode(fixture, { GAZE_HOST: '127.0.0.1', GAZE_PORT: String(PORT) });
    expect(r.code).toBe(0);
    await server.until(() => !!server.find((e) => e.title.startsWith('from dist esm')));
    const e = server.find((e) => e.title.startsWith('from dist esm'))!;
    expect(e).toMatchObject({ kind: 'log', color: 'green' });
    expect(e.origin!.file.replace(/\\/g, '/').toLowerCase()).toBe(fixture.replace(/\\/g, '/').toLowerCase());
    expect(e.origin!.line).toBe(lineOf(fixture, '@dist-esm'));
  });

  it('require(esm) through the exports map, RAY_PORT fallback', async () => {
    const fixture = pkg + 'test/e2e/fixtures/require.cjs';
    const r = await runNode(fixture, { RAY_HOST: '127.0.0.1', RAY_PORT: String(PORT) });
    expect(r.out).toBe('');
    expect(r.code).toBe(0);
    await server.until(() => !!server.find((e) => e.title == 'from require(esm)'));
    const e = server.find((e) => e.title == 'from require(esm)')!;
    expect(e).toMatchObject({ label: 'cjs' });
    expect(e.origin!.line).toBe(lineOf(fixture, '@require-cjs'));
  });

  it('--import auto-node: a trace per request, each console line once, at the app line', async () => {
    const fixture = pkg + 'test/e2e/fixtures/auto-server.mjs';
    const r = await runNode(fixture, { GAZE_HOST: '127.0.0.1', GAZE_PORT: String(PORT) }, ['--import', pathToFileURL(pkg + 'dist/auto-node.js').href]);
    expect(r.code).toBe(0);
    await server.until(() => !!server.find((e) => e.kind == 'request' && e.title.includes('/orders/7')));
    const sum = server.find((e) => e.kind == 'request' && e.title.includes('/orders/7'))!;
    const all = [...server.entries.values()];
    const inReq = all.filter((e) => e.title.includes('auto: in request'));
    expect(inReq).toHaveLength(1);
    expect(inReq[0]!.traceId).toBe(sum.traceId);
    expect(inReq[0]!.origin!.line).toBe(lineOf(fixture, '@auto-console'));
    expect(all.find((e) => e.title.includes('auto: ray in request'))!.traceId).toBe(sum.traceId);
    const outside = all.filter((e) => e.title.includes('auto: before any request'));
    expect(outside).toHaveLength(1);
    expect(outside[0]!.traceId).toBeFalsy();
  });

  it('NODE_ENV=production (or GAZE_ENABLED=false): the no-op, nothing patched, sent or exited; --conditions=production loads only noop.js', async () => {
    const env = { GAZE_HOST: '127.0.0.1', GAZE_PORT: String(PORT) };
    const quiet = { enabled: false, group: 42, console: true, channels: [], store: false, exitHooks: 0 };
    const fixture = pkg + 'test/e2e/fixtures/production.mjs';
    for (const [extra, args, resolved] of [
      [{ NODE_ENV: 'production' }, [], 'node.js'],
      [{ GAZE_ENABLED: 'false' }, [], 'node.js'],
      [{ NODE_ENV: 'production' }, ['--conditions=production'], 'noop.js'],
    ] as const) {
      const r = await runNode(fixture, { ...env, ...extra }, [...args]);
      expect(r.code, r.out).toBe(0); // die() did not exit
      expect(JSON.parse(r.out)).toEqual({ resolved, ...quiet });
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(server.find((e) => e.title.startsWith('must not arrive'))).toBeUndefined();
  });

  it('gaze-js run adds the --import only while Gaze is on', async () => {
    const run = (extra: Record<string, string>) =>
      new Promise<string>((resolve) => {
        const env: Record<string, string | undefined> = { ...process.env, GAZE_PORT: '1', ...extra };
        for (const k of ['GAZE_ENABLED', 'NODE_ENV', 'NODE_OPTIONS']) if (!(k in extra)) delete env[k];
        const p = spawn(process.execPath, [pkg + 'dist/bin.js', 'run', '--', 'node', pkg + 'test/e2e/fixtures/node-options.cjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout!.on('data', (d) => (out += d));
        p.stderr!.on('data', (d) => (out += d));
        p.on('exit', () => resolve(out.trim()));
      });
    expect(await run({})).toMatch(/^--import=file:.*auto-node\.js$/);
    expect(await run({ NODE_ENV: 'production' })).toBe('none');
    expect(await run({ GAZE_ENABLED: 'false' })).toBe('none');
  });

  it('IIFE (dist/gaze.global.js): sets globalThis.ray only if undefined, and sends from the browser build', async () => {
    const code = readFileSync(pkg + 'dist/gaze.global.js', 'utf8');
    const opts = { filename: pkg + 'dist/gaze.global.js' };
    const taken = vm.createContext({ ray: 'someone else', console });
    vm.runInContext(code, taken, opts);
    expect(taken.ray).toBe('someone else');
    expect(typeof taken.gaze).toBe('function');
    expect(typeof taken.Gaze.ray).toBe('function');

    const page = vm.createContext({ console, fetch, queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval, AbortSignal, URL, performance, crypto, Intl });
    vm.runInContext(code, page, opts);
    expect(typeof page.ray).toBe('function');
    vm.runInContext(`ray.configure({ host: '127.0.0.1', port: ${PORT}, project: 'e2e-iife' });\nray('from the IIFE', [1, 2]).orange();`, page, { filename: 'C:/site/page.js' });
    await vm.runInContext('ray.flush()', page);
    await server.until(() => !!server.find((e) => e.title.startsWith('from the IIFE')));
    const e = server.find((e) => e.title.startsWith('from the IIFE'))!;
    expect(e).toMatchObject({ kind: 'log', color: 'orange', origin: { file: 'C:/site/page.js', line: 2 } });
    expect(server.sources.get(e.sourceId)).toMatchObject({ project: 'e2e-iife', runtime: 'worker', via: 'native' });
  });

  it('a script exits promptly when the app is down (no 2 s hang per call)', async () => {
    const r = await runNode(pkg + 'test/e2e/fixtures/dist-esm.mjs', { GAZE_HOST: '127.0.0.1', GAZE_PORT: '1' });
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(5000);
  });
});
