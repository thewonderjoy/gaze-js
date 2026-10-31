import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectValidBatch, makeRay, settle } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('backoff and bounded queue', () => {
  it('backs off 1, 2, 4 … 30 s while the app is down, keeps the queue, then delivers', async () => {
    vi.useFakeTimers();
    let up = false;
    const times: number[] = [];
    const t = makeRay({
      get: async () => {
        times.push(Date.now());
        if (!up) throw new TypeError('fetch failed');
        return { status: 200, json: { v: 1 } };
      },
    });
    const t0 = Date.now();
    t.ray('queued');
    await expect(t.ray.flush()).resolves.toBeUndefined(); // never rejects
    for (let i = 0; i < 7; i++) await vi.advanceTimersByTimeAsync(31_000);
    const gaps = times.map((x, i) => (i ? x - times[i - 1]! : x - t0));
    expect(gaps.slice(0, 7)).toEqual([0, 1000, 2000, 4000, 8000, 16000, 30000]);
    up = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.entries().map((e) => (e.body as any).values[0].v)).toEqual(['queued']);
  });

  it('flush() resolves at once while backing off (does not wait 30 s)', async () => {
    const t = makeRay({
      post: async () => {
        throw new TypeError('ECONNREFUSED');
      },
    });
    t.ray('x');
    await t.ray.flush();
    const start = Date.now();
    await t.ray.flush();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('drops the oldest beyond 500 entries and reports the drop once the app is back', async () => {
    let up = false;
    const t = makeRay({
      post: async (url, body) => {
        if (!up) throw new TypeError('down');
        t.posts.push({ url, body, headers: {}, noCors: false });
        return 202;
      },
    });
    for (let i = 0; i < 700; i++) t.ray(i);
    await t.ray.flush();
    up = true;
    t.ray.configure({}); // configure() resets backoff: next send goes out now
    await t.ray.flush();
    await t.ray.flush();
    const es = t.entries();
    const values = es.filter((e) => e.kind == 'log').map((e) => (e.body as any).values[0].v);
    expect(values).toHaveLength(500);
    expect(values[0]).toBe(200);
    expect(values.at(-1)).toBe(699);
    const notice = es.find((e) => e.kind == 'text')!;
    expect(notice).toMatchObject({ label: 'gaze', color: 'orange', body: { text: '200 entries were dropped while the app was unreachable.' } });
    for (const b of t.batches()) expectValidBatch(b);
  });

  it('drops by bytes too (5 MB default, configurable)', async () => {
    let up = false;
    const t = makeRay({
      post: async (url, body) => {
        if (!up) throw new TypeError('down');
        t.posts.push({ url, body, headers: {}, noCors: false });
        return 202;
      },
    });
    t.ray.configure({ queue: { bytes: 50_000 } });
    for (let i = 0; i < 20; i++) t.ray('x'.repeat(10_000));
    await t.ray.flush();
    up = true;
    t.ray.configure({});
    await t.ray.flush();
    await t.ray.flush();
    expect(t.entries().filter((e) => e.kind == 'log').length).toBeLessThanOrEqual(5);
  });

  it('4xx (except 429) drops the batch; 429 and 5xx retry', async () => {
    const statuses = [400, 503, 202];
    const seen: string[] = [];
    const t = makeRay({
      post: async (_url, body) => {
        seen.push(JSON.parse(body).entries[0].body.values[0].v);
        return statuses.shift() ?? 202;
      },
    });
    t.ray('bad');
    await t.ray.flush(); // prints one "[gaze] the app rejected a batch (HTTP 400)" hint
    t.ray('retried');
    await t.ray.flush();
    t.ray.configure({});
    await t.ray.flush();
    expect(seen).toEqual(['bad', 'retried', 'retried']);
  });

  it('never throws into user code, even when the platform throws synchronously', async () => {
    const t = makeRay({
      post: () => {
        throw new Error('sync boom');
      },
    });
    expect(() => t.ray('x').red().label('y')).not.toThrow();
    await expect(t.ray.flush()).resolves.toBeUndefined();
  });

  it('sends the bearer token only to non-loopback hosts', async () => {
    const t = makeRay();
    t.ray.configure({ token: 'secret' });
    t.ray('local');
    await t.ray.flush();
    expect(t.posts[0]!.headers.Authorization).toBeUndefined();
    t.ray.configure({ host: '192.168.1.20' });
    t.ray('remote');
    await t.ray.flush();
    expect(t.posts[1]).toMatchObject({ url: 'http://192.168.1.20:23517/v1/batch', headers: { Authorization: 'Bearer secret' } });
  });

  it('url option targets a relay; IPv6 hosts are bracketed', async () => {
    const t = makeRay();
    t.ray.configure({ url: 'https://app.test/_gaze/' });
    t.ray('x');
    await t.ray.flush();
    expect(t.posts[0]!.url).toBe('https://app.test/_gaze/v1/batch');
    t.ray.configure({ url: undefined as any, host: '::1', port: 9 });
    // configure() ignores undefined, so clear url explicitly
    (t.ray.$client.cfg as any).url = undefined;
    t.ray('y');
    await t.ray.flush();
    expect(t.posts[1]!.url).toBe('http://[::1]:9/v1/batch');
  });

  it('hello limits and redaction are applied', async () => {
    const t = makeRay({
      get: async () => ({ status: 200, json: { v: 1, limits: { max_string_chars: 10 }, redact: ['password'] } }),
    });
    t.ray('warm-up');
    await t.ray.flush();
    t.ray('abcdefghijklmnop', { password: 'p' });
    await t.ray.flush();
    const values = (t.entries()[1]!.body as any).values;
    expect(values[0]).toEqual({ k: 'str', v: 'abcdefghij', cut: 6, len: 16 });
    expect(values[1].props[0].val).toEqual({ k: 'const', v: '[redacted]' });
  });

  it('pagehide hands queued batches (<= 64 KiB each, text/plain) to sendBeacon', async () => {
    const beacons: [string, string][] = [];
    let hide: () => void = () => {};
    const t = makeRay({
      type: 'text/plain;charset=UTF-8',
      onHide: (fn) => (hide = fn),
      beacon: (url, body) => (beacons.push([url, body]), true),
      post: async () => {
        throw new TypeError('down');
      },
    });
    t.ray('a');
    await t.ray.flush();
    for (let i = 0; i < 30; i++) t.ray('x'.repeat(5000));
    hide();
    expect(beacons.length).toBeGreaterThanOrEqual(1);
    expect(beacons.every(([u, b]) => u.endsWith('/v1/batch') && b.length <= 65000)).toBe(true);
    const sent = beacons.flatMap(([, b]) => JSON.parse(b).entries);
    expect(sent[0].body.values[0].v).toBe('a');
    expect(sent.length).toBeLessThan(31); // the 64 KiB budget is shared across beacons
  });

  it('a bridge transport replaces HTTP (Vite HMR)', async () => {
    const sent: [string, string][] = [];
    const t = makeRay();
    t.ray.configure({ bridge: { post: (p, b) => void sent.push([p, b]) } });
    t.ray('via bridge');
    await t.ray.flush();
    expect(t.posts).toEqual([]);
    expect(t.gets).toEqual([]); // no hello through the bridge
    expect(sent[0]![0]).toBe('/v1/batch');
    expect(JSON.parse(sent[0]![1]).entries[0].body.values[0].v).toBe('via bridge');
    await settle();
  });
});
