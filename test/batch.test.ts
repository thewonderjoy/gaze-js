import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectValidBatch, makeRay, settle } from './helpers.js';
import { StopExecutionRequested } from '../src/core/ray.js';
import { VERSION } from '../src/version.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('batching', () => {
  it('ray(x).blue().label() is ONE entry in ONE request', async () => {
    const t = makeRay();
    t.ray('hello', { a: 1 }).blue().label('L1');
    await t.ray.flush();
    expect(t.posts.length).toBe(1);
    expect(t.gets).toEqual(['http://localhost:23517/v1/hello']);
    const [b] = t.batches();
    expectValidBatch(b);
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]).toMatchObject({ op: 'add', kind: 'log', color: 'blue', label: 'L1', seq: 0 });
    expect(b.entries[0].body.values).toEqual([
      { k: 'str', v: 'hello' },
      { k: 'obj', cls: 'Object', props: [{ n: 'a', vis: 'pub', val: { k: 'int', v: 1 } }] },
    ]);
  });

  it('sends one request per tick for many calls, ordered by seq, one session', async () => {
    const t = makeRay();
    for (let i = 0; i < 50; i++) t.ray(i);
    await settle();
    await t.ray.flush();
    expect(t.posts.length).toBe(1);
    const [b] = t.batches();
    expectValidBatch(b);
    expect(b.entries.map((e: any) => e.seq)).toEqual([...Array(50).keys()]);
    t.ray('next tick');
    await t.ray.flush();
    expect(t.posts.length).toBe(2);
    const [b1, b2] = t.batches();
    expect(b2.session).toBe(b1.session);
    expect(b2.entries[0].seq).toBe(50);
    expect(b1.session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('client info: name, version, runtime, host, pid, project', async () => {
    const t = makeRay();
    t.ray.configure({ project: { name: 'shop', root: '/srv/shop' }, framework: 'vue', framework_version: '3.5.44' });
    t.ray('x');
    await t.ray.flush();
    expect(t.batches()[0].client).toEqual({
      name: '@thewonderjoy/gaze-js',
      version: VERSION,
      runtime: 'node',
      runtime_version: '24.0.0',
      framework: 'vue',
      framework_version: '3.5.44',
      host: 'test-host',
      pid: 42,
      project: { name: 'shop', root: '/srv/shop' },
    });
  });

  it('a modifier after the tick becomes a patch for the same id; later content an update', async () => {
    const t = makeRay();
    const r = t.ray('first');
    await t.ray.flush();
    r.red().large();
    r.send('second');
    await t.ray.flush();
    const [, b2] = t.batches();
    expectValidBatch(b2);
    // patch then content in the same tick fold into one update entry
    expect(b2.entries).toHaveLength(1);
    expect(b2.entries[0]).toMatchObject({ op: 'update', id: r.id, color: 'red', size: 'lg', kind: 'log' });
    r.hide();
    await t.ray.flush();
    const b3 = t.batches()[2];
    expectValidBatch(b3);
    expect(b3.entries[0]).toEqual(expect.objectContaining({ op: 'patch', id: r.id, hidden: true }));
    expect(b3.entries[0].body).toBeUndefined();
  });

  it('modifiers before content fold into the add; remove, append and explicit ids', async () => {
    const t = makeRay();
    t.ray().green().text('later content');
    const cart = t.ray.at('cart');
    cart.send({ items: 1 });
    await t.ray.flush();
    t.ray.at('cart').send({ items: 2 });
    cart.append('iteration');
    await t.ray.flush();
    t.ray.at('cart').remove();
    await t.ray.flush();
    const all = t.batches();
    for (const b of all) expectValidBatch(b);
    const [b1, b2, b3] = all;
    expect(b1.entries[0]).toMatchObject({ op: 'add', kind: 'text', color: 'green', body: { text: 'later content' } });
    expect(b1.entries[1]).toMatchObject({ op: 'add', id: 'at:cart_', kind: 'log' });
    expect(b2.entries.map((e: any) => [e.op, e.id])).toEqual([
      ['add', 'at:cart_'],
      ['append', 'at:cart_'],
    ]);
    expect(b3.entries[0]).toEqual(expect.objectContaining({ op: 'remove', id: 'at:cart_' }));
  });

  it('count() updates one entry in place; counterValue/clearCounters', async () => {
    const t = makeRay();
    for (let i = 0; i < 3; i++) t.ray().count('loop');
    expect(t.ray().counterValue('loop')).toBe(3);
    await t.ray.flush();
    const es = t.entries();
    expect(es.map((e) => e.op)).toEqual(['add']); // folded inside one tick
    expect((es[0]!.body as any).values[0].v).toBe('Called `loop` 3 times.');
    t.ray().count('loop');
    await t.ray.flush();
    const last = t.entries().at(-1)!;
    expect(last).toMatchObject({ op: 'update', id: es[0]!.id });
    expect((last.body as any).values[0].v).toBe('Called `loop` 4 times.');
    t.ray.clearCounters();
    expect(t.ray().counterValue('loop')).toBe(0);
  });

  it('once/limit fingerprint the call site; if/showIf/removeIf', async () => {
    const t = makeRay();
    for (let i = 0; i < 5; i++) t.ray().once(i);
    for (let i = 0; i < 5; i++) t.ray().limit(2).send('l' + i);
    t.ray('muted').if(false).red();
    t.ray().if(true, (r) => r.text('cb'));
    t.ray('gone').showIf(false);
    t.ray('kept').removeIf(() => false);
    await t.ray.flush();
    const vals = t.entries().filter((e) => e.op != 'remove').map((e) => (e.body as any)?.values?.[0]?.v ?? (e.body as any)?.text);
    expect(vals).toEqual([0, 'l0', 'l1', 'muted', 'cb', 'gone', 'kept']);
    expect(t.entries().filter((e) => e.op == 'remove')).toHaveLength(1);
    // if(false) mutes later calls on the chain: no color patch for 'muted'
    expect(t.entries().find((e) => (e.body as any)?.values?.[0]?.v == 'muted')?.color).toBeUndefined();
  });

  it('enable/disable skip capture and serialization entirely', async () => {
    const t = makeRay();
    t.ray.disable();
    let read = 0;
    const r = t.ray({
      get x() {
        return read++;
      },
    });
    expect(r.pass(5)).toBe(5);
    expect(read).toBe(0);
    expect(t.ray.enabled()).toBe(false);
    t.ray.enable();
    await t.ray.flush();
    expect(t.posts).toHaveLength(0);
    t.ray('on again');
    await t.ray.flush();
    expect(t.posts).toHaveLength(1);
  });

  it('rate limiter sends one notice, then drops until clear(), which lifts the limits', async () => {
    const t = makeRay();
    t.ray.rateLimiter().max(2).perSecond(100);
    for (let i = 0; i < 5; i++) t.ray(i);
    await t.ray.flush();
    const es = t.entries();
    expect(es.map((e) => e.kind)).toEqual(['log', 'log', 'text']);
    expect(es[2]).toMatchObject({ label: 'Rate limit', body: { text: 'Rate limit has been reached...' } });
    // As in gaze-php and spatie/ray: clear() removes max and perSecond, not only the count.
    t.ray.rateLimiter().clear();
    for (let i = 0; i < 4; i++) t.ray('again', i);
    await t.ray.flush();
    expect(t.entries().slice(3).map((e) => e.kind)).toEqual(['log', 'log', 'log', 'log']);
  });

  it('macro adds chainable methods', async () => {
    const t = makeRay();
    t.ray.macro('double', function (n: number) {
      return this.send(n * 2);
    });
    (t.ray() as any).double(21).red();
    await t.ray.flush();
    expect(t.entries()[0]).toMatchObject({ color: 'red', body: { values: [{ k: 'int', v: 42 }] } });
  });
});

describe('kinds', () => {
  it('every content kind produces a schema-valid batch', async () => {
    const t = makeRay();
    const r = t.ray;
    r().text('a  b\nc');
    r().html('<b>x</b>');
    r().markdown('# T');
    r().mermaid('graph TD; A-->B');
    r().json('{"a":[1,2]}', 'not json');
    r().toJson({ a: 1 });
    r().xml('<a><b>1</b></a>');
    r().table({ First: 'a', Second: { x: 1 } }, 'My table');
    r().table([
      { id: 1, name: 'a' },
      { id: 2, name: 'b', extra: true },
    ]);
    r().table(new Map([['k', 1]]));
    r().image('https://example.test/a.png');
    r().date(new Date(2026, 9, 31, 12, 0, 0));
    r().className(new Map());
    r().separator();
    r().newScreen('Screen A');
    r().clearScreen();
    r().clearAll();
    r().screenColor('red');
    r().showApp();
    r().hideApp();
    r().notify('done');
    r().confetti();
    r().trace(5);
    r().caller();
    r().exception(new AggregateError([new Error('a'), new Error('b')], 'many', { cause: new RangeError('root') }), { orderId: 5 });
    r().exception('a string');
    r().measure('t1');
    r().measure('t1');
    r().measure(() => 1);
    r().entry('http', { method: 'GET', url: '/x', status: 200 });
    r('expand').expand('a.b', 2).expandAll();
    r('pass').small().purple().gray().orange().yellow().grey();
    r.group('checkout', () => r('inside group'));
    await r.flush();
    const [b] = t.batches();
    expectValidBatch(b);
    const kinds = b.entries.map((e: any) => e.kind);
    expect(kinds).toEqual([
      'text', 'html', 'markdown', 'mermaid', 'json', 'json', 'text', 'table', 'table', 'table', 'image', 'date', 'log', 'separator',
      'cmd', 'cmd', 'cmd', 'cmd', 'cmd', 'cmd', 'cmd', 'cmd', 'trace', 'trace', 'exception', 'exception', 'measure', 'measure',
      'measure', 'http', 'log', 'log', 'log', 'group',
    ]);
    const by = (k: string) => b.entries.filter((e: any) => e.kind == k);
    expect(by('cmd').map((e: any) => e.body)).toEqual([
      { cmd: 'new_screen', name: 'Screen A' },
      { cmd: 'new_screen', name: '' },
      { cmd: 'clear' },
      { cmd: 'screen_color', color: 'red' },
      { cmd: 'show_app' },
      { cmd: 'hide_app' },
      { cmd: 'notify', text: 'done' },
      { cmd: 'confetti' },
    ]);
    const [rowsTable] = by('table').slice(1);
    expect(rowsTable.body.columns).toEqual(['id', 'name', 'extra']);
    expect(rowsTable.body.rows[0][2]).toEqual({ k: 'undef' });
    expect(by('json')[0].body.value).toMatchObject({ k: 'list', count: 2, items: [{ k: 'obj' }, { k: 'str', v: 'not json' }] });
    expect(by('date')[0].body).toMatchObject({ formatted: '2026-10-31 12:00:00' });
    expect(by('log')[0].body.values).toEqual([{ k: 'str', v: 'Map' }]);
    const ex = by('exception')[0];
    expect(ex).toMatchObject({ color: 'red', body: { class: 'AggregateError', message: 'many', previous: { class: 'RangeError', message: 'root' } } });
    expect(ex.body.frames[0].file).toContain('batch.test.ts');
    const ctx = ex.body.context;
    expect(ctx.props.map((p: any) => p.n)).toEqual(['cause', 'errors', 'orderId']);
    expect(ctx.props[1].val).toMatchObject({ k: 'list', count: 2, items: [{ k: 'err', message: 'a' }, { k: 'err', message: 'b' }] });
    expect(by('exception')[1].body).toMatchObject({ class: 'string', message: 'a string', frames: [] });
    const [m1, m2, m3] = by('measure');
    expect(m1.body).toMatchObject({ name: 't1', is_new: true, total_ms: 0 });
    expect(m2.body).toMatchObject({ name: 't1', is_new: false });
    expect(m2.body.mem_peak).toBeUndefined(); // fake platform has no mem()
    expect(m3.body).toMatchObject({ name: 'closure', is_new: false });
    const exp = b.entries.find((e: any) => e.body?.values?.[0]?.v == 'expand');
    expect(exp.expand).toEqual({ level: 999 });
    const pass = b.entries.find((e: any) => e.body?.values?.[0]?.v == 'pass');
    expect(pass).toMatchObject({ size: 'sm', color: 'gray' });
    const grp = by('group')[0];
    const inner = b.entries.find((e: any) => e.body?.values?.[0]?.v == 'inside group');
    expect(inner.trace).toMatchObject({ kind: 'other', name: 'checkout' });
    expect(grp.trace).toMatchObject({ id: inner.trace.id, ended: true });
    expect(grp.body.name).toBe('checkout');
    expect(by('trace')[0].body.frames[0].file).toContain('batch.test.ts');
  });

  it('inputs the app would reject are normalised client-side (one bad entry would drop the batch)', async () => {
    const t = makeRay();
    t.ray('x')
      .label('y'.repeat(300))
      .color('pink' as any)
      .size('huge' as any)
      .expand(1.7);
    t.ray('y').expand(-3);
    t.ray().entry('HTTP Request', { a: 1 });
    t.ray().entry('9lives', [1] as any);
    await t.ray.flush();
    const [b] = t.batches();
    expectValidBatch(b);
    expect(b.entries[0].label).toHaveLength(200);
    expect(b.entries[0].color).toBeUndefined();
    expect(b.entries[0].size).toBeUndefined();
    expect(b.entries[0].expand).toEqual({ level: 1 });
    expect(b.entries[1].expand).toEqual({ level: 0 });
    expect(b.entries[2].kind).toBe('http_request');
    expect(b.entries[3]).toMatchObject({ kind: 'x9lives', body: { value: [1] } });
  });

  it('watch() re-sends to one entry only when the value changes', async () => {
    vi.useFakeTimers();
    const t = makeRay();
    let v = 1;
    const stop = t.ray.watch(() => v, { interval: 100, label: 'v' });
    await t.ray.flush();
    await vi.advanceTimersByTimeAsync(250);
    v = 2;
    await vi.advanceTimersByTimeAsync(100);
    stop();
    v = 3;
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    await t.ray.flush();
    const es = t.entries();
    expect(new Set(es.map((e) => e.id)).size).toBe(1);
    expect(es.map((e) => (e.body as any).values[0].v)).toEqual([1, 2]);
    expect(es[0]).toMatchObject({ label: 'v' });
  });

  it('pause() flushes, long-polls the lock, resolves on Continue and throws on Stop; never hangs when down', async () => {
    let polls = 0;
    let end = 'released';
    const t = makeRay({
      get: async (url) => {
        if (url.endsWith('/v1/hello')) return { status: 200, json: { v: 1 } };
        polls++;
        expect(url).toMatch(/\/v1\/locks\/[0-9a-f-]{36}\?wait=25$/);
        return { status: 200, json: { state: polls % 2 ? 'active' : end } };
      },
    });
    await expect(t.ray().pause()).resolves.toBe('released');
    expect(t.entries()[0]).toMatchObject({ kind: 'lock' });
    expect(polls).toBe(2);
    end = 'stopped';
    const stop = await t.ray().pause().catch((e: unknown) => e);
    expect(stop).toBeInstanceOf(StopExecutionRequested);
    expect(stop).toBeInstanceOf(Error);
    expect(stop).toMatchObject({ name: 'StopExecutionRequested' });
    expect(polls).toBe(4);
    const down = makeRay({
      get: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(down.ray().pause()).resolves.toBe('released');
  });

  it('die() flushes and then exits through the platform', async () => {
    const exit = vi.fn();
    const t = makeRay({ exit });
    await expect(t.ray('bye').die(3)).rejects.toThrow('die');
    expect(exit).toHaveBeenCalledWith(3);
    expect(t.entries()).toHaveLength(1);
  });
});
