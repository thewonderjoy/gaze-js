// Node async traces: groups that run concurrently, one trace per HTTP request (diagnostics channel, no
// middleware), and SQL folding per trace.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureConsole } from '../src/capture.js';
import type { WireEntry } from '../src/core/types.js';
import { captureRequests } from '../src/node/requests.js';
import { captureQueries, fingerprint, inline, patchPg, shape } from '../src/node/sql.js';
import { ctx, mapFrame } from '../src/platform/node.js';
import { expectValidBatch, lineOf, makeRay, settle } from './helpers.js';

const here = fileURLToPath(import.meta.url);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (e: WireEntry) => JSON.stringify(e.body);
const undo: (() => void)[] = [];
afterEach(() => undo.splice(0).forEach((f) => f()));

async function server(handler: http.RequestListener): Promise<[number, http.Server]> {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return [(s.address() as { port: number }).port, s];
}

describe('async traces in Node', () => {
  it('keeps concurrent groups apart', async () => {
    const { ray, entries } = makeRay({ ctx });
    await Promise.all(
      ['a', 'b', 'c'].map((n) =>
        ray.group(n, async () => {
          ray(`${n}-1`);
          await sleep(Math.random() * 10);
          ray(`${n}-2`);
        }),
      ),
    );
    await ray.flush();
    for (const n of ['a', 'b', 'c']) {
      const mine = entries().filter((e) => text(e).includes(`"${n}-`));
      expect(mine).toHaveLength(2);
      expect(new Set(mine.map((e) => e.trace?.name))).toEqual(new Set([n]));
    }
  });

  it('opens one trace per request, also inside req.on(data/end)', async () => {
    const { ray, entries, batches } = makeRay({ ctx });
    undo.push(captureRequests(ray, ctx));
    const [port, s] = await server((req, res) => {
      ray(`start ${req.url}`);
      req.on('data', () => {});
      req.on('end', async () => {
        await sleep(Math.random() * 10);
        ray(`end ${req.url}`);
        res.end('ok');
      });
    });
    const urls = Array.from({ length: 8 }, (_, i) => `/r${i}`);
    // Bodies over 64 KiB arrive in several socket reads, outside the request's own context.
    await Promise.all(urls.map((u) => fetch(`http://127.0.0.1:${port}${u}`, { method: 'POST', body: 'x'.repeat(300_000) }).then((r) => r.text())));
    s.close();
    await settle(20);
    await ray.flush();
    for (const b of batches()) expectValidBatch(b);
    for (const u of urls) {
      const sum = entries().find((e) => e.kind == 'request' && (e.body as { uri: string }).uri == u)!;
      expect(sum.trace).toMatchObject({ kind: 'http', name: `POST ${u}`, ended: true });
      expect(sum.body).toMatchObject({ method: 'POST', status: 200 });
      const mine = entries().filter((e) => text(e).includes(` ${u}"`));
      expect(mine.map((e) => e.trace?.id)).toEqual([sum.trace!.id, sum.trace!.id]);
    }
  });

  it('sends traceparent on calls to local servers and records its span on the call', async () => {
    const { ray, entries } = makeRay({ ctx });
    const { captureNetwork } = await import('../src/capture.js');
    undo.push(captureNetwork(ray));
    const seen: string[] = [];
    const [port, s] = await server((q, res) => (seen.push(String(q.headers.traceparent ?? '')), res.end()));
    await ray.group('checkout', async () => {
      await fetch(`http://127.0.0.1:${port}/a`);
      await fetch(`http://localhost:${port}/b`, { headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' } });
      await new Promise((r) => http.get(`http://127.0.0.1:${port}/c`, (res) => (res.resume(), res.on('end', r))));
    });
    s.close();
    await ray.flush();
    const calls = entries().filter((e) => e.kind == 'http');
    const group = calls[0]!.trace!.id;
    expect(seen[0]).toMatch(new RegExp(`^00-${group}-[0-9a-f]{16}-01$`));
    expect(seen[1]).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(seen[2]).toMatch(new RegExp(`^00-${group}-[0-9a-f]{16}-01$`));
    const span = (url: string) => (calls.find((e) => (e.body as { url: string }).url.endsWith(url))!.body as { span_id?: string }).span_id;
    expect(span('/a')).toBe(seen[0]!.split('-')[2]);
    expect(span('/b')).toBeUndefined();
    expect(span('/c')).toBe(seen[2]!.split('-')[2]);
  });

  it('takes an incoming traceparent as the parent span and skips dev-server assets', async () => {
    const { ray, entries } = makeRay({ ctx });
    undo.push(captureRequests(ray, ctx));
    const [port, s] = await server((_q, res) => res.end());
    const tid = '4bf92f3577b34da6a3ce929d0e0e4736';
    await fetch(`http://127.0.0.1:${port}/api`, { headers: { traceparent: `00-${tid}-00f067aa0ba902b7-01` } });
    await fetch(`http://127.0.0.1:${port}/@vite/client`);
    await fetch(`http://127.0.0.1:${port}/app.js`, { headers: { 'sec-fetch-dest': 'script' } });
    s.close();
    await settle(20);
    await ray.flush();
    const sums = entries().filter((e) => e.kind == 'request');
    expect(sums.map((e) => e.trace?.name)).toEqual(['GET /api']);
    // A trace of its own: requests that share one distributed trace id must not merge.
    expect(sums[0]!.trace).toMatchObject({ parent: '00f067aa0ba902b7' });
    expect(sums[0]!.trace!.id).not.toBe(tid);
  });

  it('closes the trace of a request whose client went away', async () => {
    const { ray, entries } = makeRay({ ctx });
    undo.push(captureRequests(ray, ctx));
    const [port, s] = await server(() => {});
    const ac = new AbortController();
    const p = fetch(`http://127.0.0.1:${port}/slow`, { signal: ac.signal }).catch(() => {});
    await sleep(100);
    ac.abort();
    await p;
    await sleep(100);
    s.closeAllConnections();
    s.close();
    await ray.flush();
    const sum = entries().find((e) => e.kind == 'request')!;
    expect(sum.body).toMatchObject({ uri: '/slow', status: 0, aborted: true });
    expect(sum.trace).toMatchObject({ name: 'GET /slow', ended: true });
  });
});

describe('origins in Node', () => {
  it('maps a frame in generated code through its source map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gaze-map-'));
    const out = join(dir, 'out.js');
    // Built from parts: a literal source-map comment here would be read by Vitest as this file's own.
    writeFileSync(out, ['x();', '//# source' + 'MappingURL=out.js.map', ''].join('\n'));
    // generated 1:1 -> src/app.ts 10:1 ("AASA": col 0, source 0, line +9, col 0)
    writeFileSync(out + '.map', JSON.stringify({ version: 3, sources: ['src/app.ts'], names: [], mappings: 'AASA' }));
    expect(mapFrame({ file: out, line: 1, col: 1 })).toMatchObject({ file: join(dir, 'src', 'app.ts'), line: 10, col: 1 });
    expect(mapFrame({ file: here, line: 3, col: 1 })).toEqual({ file: here, line: 3, col: 1 });
  });

  it('gives console lines the app frame, and skips dependency chatter outside any trace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gaze-dep-'));
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    const dep = join(dir, 'node_modules', 'dep', 'index.mjs');
    // Logs from its own timer, so no app frame is on the stack (like a framework's start-up banner).
    writeFileSync(dep, 'export const log = (m) => new Promise((r) => setTimeout(() => (console.log(m), r())));\n');
    const { log } = await import(pathToFileURL(dep).href);
    const { ray, entries } = makeRay({ ctx, mapFrame });
    const off = captureConsole(ray);
    try {
      console.log('from the app'); // @console-app
      await log('dependency outside a trace');
      await ray.group('job', () => log('dependency inside a trace'));
    } finally {
      off();
    }
    await ray.flush();
    const by = (t: string) => entries().filter((e) => JSON.stringify(e.body).includes(t));
    const o = by('from the app')[0]!.origin!;
    const slash = (p: string) => p.replace(/\\/g, '/');
    expect([slash(o.file!), o.line]).toEqual([slash(here), lineOf(here, '@console-app')]);
    expect(by('dependency outside a trace')).toHaveLength(0);
    const inside = by('dependency inside a trace');
    expect(inside).toHaveLength(1);
    expect(inside[0]!.origin).toBeUndefined();
    expect(inside[0]!.trace?.name).toBe('job');
  });
});

describe('SQL', () => {
  it('reduces values so runs of one query shape match', () => {
    expect(shape("SELECT *  FROM users WHERE id = 5 AND name = 'o''neil'")).toBe('select * from users where id = ? and name = ?');
    expect(shape('select * from t where id in (1, 2, 3)')).toBe(shape('select * from t where id in ($1)'));
    expect(fingerprint('select * from t where id = 1', 'pgsql')).toBe(fingerprint('select * from t where id = $1', 'pgsql'));
    expect(fingerprint('select 1', 'pgsql')).not.toBe(fingerprint('select 1', 'mysql'));
  });

  it('fills values into a display copy of the SQL', () => {
    expect(inline("select * from t where a = $2 and b = $1 and c = '$1'", [5, "o'k"])).toBe("select * from t where a = 'o''k' and b = 5 and c = '$1'");
    expect(inline('insert into t values (?, ?, ?, ?)', [null, true, new Date(0), new Uint8Array(3)])).toBe("insert into t values (NULL, true, '1970-01-01T00:00:00.000Z', <3 bytes>)");
    expect(inline('select ?', [])).toBe('select ?');
  });

  it('folds an N+1 in a trace into its first entry and removes the separate rows', async () => {
    const { ray, entries } = makeRay({ ctx });
    const q = captureQueries(ray, ctx);
    undo.push(q.undo);
    class Client {
      query(_text: string, _values: unknown[], cb: (e: unknown, r: unknown) => void) {
        setImmediate(() => cb(null, { rows: [] }));
      }
    }
    const pg = { Client };
    undo.push(patchPg(pg, q.rec)!);
    const c = new pg.Client();
    const run = (sql: string, v: unknown[]) => new Promise((r) => c.query(sql, v, r));
    await ray.group('orders', async () => {
      await run('select * from orders', []);
      for (let i = 1; i <= 5; i++) await run('select * from customers where id = $1', [i]);
    });
    await ray.flush();
    const es = entries().filter((e) => e.kind == 'query' || e.op == 'remove');
    const first = es.find((e) => e.op == 'add' && text(e).includes('customers'))!;
    const removed = es.filter((e) => e.op == 'remove').map((e) => e.id);
    const adds = es.filter((e) => e.op == 'add' && text(e).includes('customers')).map((e) => e.id);
    expect(adds.slice(1)).toEqual(removed);
    const last = es.filter((e) => e.op == 'update' && e.id == first.id).pop()!;
    expect(last.body).toMatchObject({ driver: 'pgsql', count: 5, flags: ['n+1'], n_plus_one: { count: 5, threshold: 3 } });
    expect((last.body as { executions: unknown[] }).executions).toHaveLength(5);
    expect(new Set(es.filter((e) => e.kind == 'query').map((e) => e.trace?.name))).toEqual(new Set(['orders']));
  });

  it('reads the mysql2 and postgres.js tracing channels', async () => {
    const { ray, entries } = makeRay({ ctx });
    undo.push(captureQueries(ray, ctx).undo);
    const dc = await import('node:diagnostics_channel');
    // mysql2 (callback API): traceCallback around the command; postgres.js: start/end, then async*.
    const mysql = dc.tracingChannel('mysql2:query');
    const pgjs = dc.tracingChannel('postgres:query');
    await ray.group('db', async () => {
      await new Promise<void>((r) => mysql.traceCallback((cb: (e: unknown) => void) => setImmediate(() => cb(null)), 0, { query: 'select * from t where id = ?', values: [7] }, null, () => r()));
      await pgjs.tracePromise(async () => sleep(1), { query: 'select * from u where id = $1', parameters: [8] });
      await new Promise<void>((r) => mysql.traceCallback((cb: (e: unknown) => void) => setImmediate(() => cb(new Error('no table'))), 0, { query: 'select * from nope', values: [] }, null, () => r()));
    });
    await ray.flush();
    const qs = entries().filter((e) => e.kind == 'query');
    expect(qs.map((e) => [e.body!.driver, e.body!.sql, e.trace?.name])).toEqual([
      ['mysql', 'select * from t where id = 7', 'db'],
      ['pgsql', 'select * from u where id = 8', 'db'],
      ['mysql', 'select * from nope', 'db'],
    ]);
    expect(qs[2]!.body).toMatchObject({ error: 'no table', flags: ['failed'] });
  });

  it('runs a busy pool callback in the context of the request that asked', async () => {
    const { ray, entries } = makeRay({ ctx });
    const q = captureQueries(ray, ctx);
    undo.push(q.undo);
    // A one-client pool: the next waiter is called from inside the previous holder's release().
    const waiting: ((c: unknown) => void)[] = [];
    let busy = false;
    class Client {
      query(_t: string, _v: unknown[], cb: (e: unknown, r: unknown) => void) {
        setImmediate(() => cb(null, {}));
      }
    }
    const client = new Client();
    class Pool {
      connect(cb: (e: unknown, c: unknown, release: () => void) => void) {
        const give = () => cb(null, client, () => ((busy = false), waiting.length && ((busy = true), waiting.shift()!(client))));
        if (busy) waiting.push(give);
        else (busy = true), give();
      }
    }
    undo.push(patchPg({ Client, Pool }, q.rec)!);
    const pool = new Pool();
    const one = (n: string) =>
      ray.group(n, () => new Promise<void>((r) => pool.connect((_e, c: any, release) => c.query(`select '${n}'`, [], () => (release(), r())))));
    await Promise.all(['a', 'b', 'c'].map(one));
    await ray.flush();
    for (const n of ['a', 'b', 'c']) expect(entries().find((e) => e.kind == 'query' && text(e).includes(`'${n}'`))?.trace?.name).toBe(n);
  });
});
