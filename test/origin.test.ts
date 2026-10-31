import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { callerFrames, isOwn, parseStack } from '../src/core/stack.js';
import { lineOf, makeRay } from './helpers.js';

const FILE = fileURLToPath(import.meta.url);
const sameFile = (f: string | undefined) => (f ?? '').replace(/\\/g, '/').toLowerCase().endsWith('test/origin.test.ts');

describe('origin capture', () => {
  it('ray(x) records the file:line:col of the caller, synchronously', async () => {
    const t = makeRay();
    t.ray('origin A'); // @origin-A
    t.ray().text('origin B').red(); // @origin-B
    function helper() {
      return t.ray('origin C'); // @origin-C
    }
    helper();
    await t.ray.flush();
    const [a, b, c] = t.entries();
    expect(sameFile(a!.origin?.file)).toBe(true);
    expect(a!.origin!.line).toBe(lineOf(FILE, '@origin-A'));
    expect(a!.origin!.col).toBe(7); // `    t.ray(` -> the call starts at column 5, `ray` at 7
    expect(b!.origin!.line).toBe(lineOf(FILE, '@origin-B'));
    expect(c!.origin).toMatchObject({ line: lineOf(FILE, '@origin-C'), function: 'helper' });
  });

  it('works for ray.at(id), count() and the capture wrappers (our frames are skipped)', async () => {
    const t = makeRay();
    t.ray.at('explicit-id').send(1); // @origin-at
    const info = console.info;
    console.info = () => {}; // the wrapper calls through to this silent stand-in
    const off = await t.ray.capture({ console: true });
    try {
      console.info('captured'); // @origin-console
    } finally {
      off();
      console.info = info;
    }
    await t.ray.flush();
    const [at, con] = t.entries();
    expect(at!.origin!.line).toBe(lineOf(FILE, '@origin-at'));
    expect(con).toMatchObject({ label: 'console.info', color: 'blue' });
    expect(sameFile(con!.origin?.file)).toBe(true);
    expect(con!.origin!.line).toBe(lineOf(FILE, '@origin-console'));
  });

  it('ray.at$() (Vite call-site transform) uses the given origin and skips the stack', async () => {
    const t = makeRay();
    t.ray.at$('/abs/src/App.vue', 42, 7)('tagged').blue();
    await t.ray.flush();
    expect(t.entries()[0]).toMatchObject({ origin: { file: '/abs/src/App.vue', line: 42, col: 7 }, color: 'blue' });
  });

  it('origin: false turns capture off', async () => {
    const t = makeRay();
    t.ray.configure({ origin: false });
    t.ray('no origin');
    await t.ray.flush();
    expect(t.entries()[0]!.origin).toBeUndefined();
  });

  it('callerFrames drops our own frames and keeps the user chain', () => {
    function outer() {
      return inner();
    }
    function inner() {
      return callerFrames(undefined, 3);
    }
    const frames = outer();
    expect(frames[0]).toMatchObject({ function: 'inner' });
    expect(frames[1]).toMatchObject({ function: 'outer' });
    expect(frames.every((f) => !isOwn(f.file))).toBe(true);
  });
});

describe('parseStack', () => {
  it('parses V8 frames (named, anonymous, async, new, method, [as], Windows paths, file URLs, query strings)', () => {
    const stack = [
      'Error: boom',
      '    at Cart.total [as sum] (file:///D:/app/src/cart.ts?t=123:10:5)',
      '    at async loadAll (http://localhost:5173/src/main.ts?v=abc:3:9)',
      '    at new Widget (C:\\work\\app\\widget.js:7:11)',
      '    at Object.<anonymous> (/srv/app/index.js:1:1)',
      '    at file:///srv/app/top.mjs:2:3',
      '    at Promise.all (index 0)',
      '    at node:internal/process/task_queues:105:5',
      '    at run (/srv/app/node_modules/lib/index.js:4:4)',
    ].join('\n');
    expect(parseStack(stack)).toEqual([
      { file: 'file:///D:/app/src/cart.ts', line: 10, col: 5, class: 'Cart', function: 'total' },
      { file: 'http://localhost:5173/src/main.ts', line: 3, col: 9, function: 'loadAll' },
      { file: 'C:\\work\\app\\widget.js', line: 7, col: 11, function: 'Widget' },
      { file: '/srv/app/index.js', line: 1, col: 1 },
      { file: 'file:///srv/app/top.mjs', line: 2, col: 3 },
      { file: 'node:internal/process/task_queues', line: 105, col: 5, vendor: true },
      { file: '/srv/app/node_modules/lib/index.js', line: 4, col: 4, function: 'run', vendor: true },
    ]);
  });

  it('parses SpiderMonkey and JavaScriptCore frames', () => {
    const stack = ['onClick@http://localhost:5173/src/App.vue?t=1:42:7', '@http://localhost:5173/src/main.ts:5:1', 'Foo.prototype.bar@https://x.test/a.js:1:2'].join('\n');
    expect(parseStack(stack)).toEqual([
      { file: 'http://localhost:5173/src/App.vue', line: 42, col: 7, function: 'onClick' },
      { file: 'http://localhost:5173/src/main.ts', line: 5, col: 1 },
      { file: 'https://x.test/a.js', line: 1, col: 2, class: 'Foo.prototype', function: 'bar' },
    ]);
  });

  it('a project folder named my-ray-app is not treated as ours (node-ray defect #9)', () => {
    expect(isOwn('/home/u/my-ray-app/src/main.ts')).toBe(false);
    const here = parseStack(new Error().stack)[0]!.file; // the stack's own path format
    expect(isOwn(here.replace(/test[\\/]origin\.test\.ts$/, 'src/core/ray.ts'))).toBe(true);
    expect(isOwn(here)).toBe(false);
  });
});
