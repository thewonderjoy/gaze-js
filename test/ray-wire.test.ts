import { describe, expect, it } from 'vitest';
import { rayEnvelope } from '../src/core/ray-wire.js';
import { serialize } from '../src/core/serialize.js';
import { makeRay } from './helpers.js';

const meta = { project_name: 'shop', client_name: '@thewonderjoy/gaze-js', client_version: '0.1.0' };
const env = (e: any) => JSON.parse(rayEnvelope({ seq: 0, id: 'abcdefgh-1', ...e }, meta, 'host-1'));

describe('Ray-compat envelopes (research note 01 §4.1)', () => {
  it('log values: scalars as plain JSON in one log payload, bool/null as custom, structures as json_string', () => {
    const e = env({
      op: 'add',
      kind: 'log',
      body: { values: [serialize('a'), serialize(1), serialize(true), serialize(null), serialize({ b: [1, 2] }), serialize(2.5)] },
      origin: { file: '/app/x.ts', line: 3, col: 1, function: 'go' },
    });
    expect(e.uuid).toBe('abcdefgh-1');
    expect(e.meta).toEqual(meta);
    expect(e.payloads.map((p: any) => [p.type, p.content])).toEqual([
      ['log', { values: ['a', 1] }],
      ['custom', { content: true, label: 'Boolean' }],
      ['custom', { content: null, label: 'Null' }],
      ['json_string', { value: '{"b":[1,2]}' }],
      ['log', { values: [2.5] }],
    ]);
    expect(e.payloads[0].origin).toEqual({ file: '/app/x.ts', line_number: 3, hostname: 'host-1', function_name: 'go' });
  });

  it('modifiers ride in the same envelope; patch carries only modifiers; remove', () => {
    const add = env({ op: 'add', kind: 'text', body: { text: 'a <b>  c\nd' }, color: 'blue', size: 'lg', label: 'L', hidden: true, expand: { level: 2, paths: ['a.b'] } });
    expect(add.payloads.map((p: any) => [p.type, p.content])).toEqual([
      ['custom', { content: 'a&nbsp;&lt;b&gt;&nbsp;&nbsp;c<br>d', label: 'Text' }],
      ['color', { color: 'blue' }],
      ['size', { size: 'lg' }],
      ['label', { label: 'L' }],
      ['hide', {}],
      ['expand', { keys: ['a.b'], level: 2 }],
    ]);
    expect(env({ op: 'patch', color: 'red' }).payloads.map((p: any) => p.type)).toEqual(['color']);
    expect(env({ op: 'remove' }).payloads.map((p: any) => p.type)).toEqual(['remove']);
  });

  it('maps every native kind to its Ray payload type', () => {
    const one = (kind: string, body: any) => env({ op: 'add', kind, body }).payloads[0];
    expect(one('html', { html: '<i>x</i>' })).toMatchObject({ type: 'custom', content: { content: '<i>x</i>', label: 'HTML' } });
    expect(one('markdown', { markdown: '# T' })).toMatchObject({ type: 'ai_custom_markdown', content: { markdown: '# T' } });
    expect(one('mermaid', { source: 'graph TD' })).toMatchObject({ type: 'ai_custom_mermaid', content: { mermaid: 'graph TD' } });
    expect(one('json', { value: serialize({ a: 1 }) })).toMatchObject({ type: 'json_string', content: { value: '{"a":1}' } });
    expect(one('image', { src: 'a".png' })).toMatchObject({ type: 'custom', content: { content: '<img src="a&quot;.png" alt="" />', label: 'Image' } });
    expect(one('date', { formatted: '2026-10-31 12:00:00', timestamp: 1, timezone: 'UTC' })).toMatchObject({ type: 'carbon', content: { formatted: '2026-10-31 12:00:00', timestamp: 1, timezone: 'UTC' } });
    expect(one('separator', {})).toMatchObject({ type: 'separator', content: {} });
    expect(one('lock', { name: 'n1' })).toMatchObject({ type: 'create_lock', content: { name: 'n1' } });
    expect(one('trace', { frames: [{ file: '/a.ts', line: 2, function: 'f', class: 'C' }] })).toMatchObject({
      type: 'trace',
      content: { frames: [{ file_name: '/a.ts', line_number: 2, class: 'C', method: 'f', vendor_frame: false }] },
    });
    expect(one('exception', { class: 'TypeError', message: 'm', frames: [{ file: '/a.ts', line: 2 }], context: serialize({ k: 1 }) })).toMatchObject({
      type: 'exception',
      content: { class: 'TypeError', message: 'm', frames: [{ file_name: '/a.ts', line_number: 2, class: null, method: '', vendor_frame: false, snippet: [] }], meta: { k: 1 } },
    });
    expect(one('measure', { name: 't', total_ms: 5, since_last_ms: 2, is_new: false, mem_peak: 10, mem_delta: 1 })).toMatchObject({
      type: 'measure',
      content: { name: 't', is_new_timer: false, total_time: 5, max_memory_usage_during_total_time: 10, time_since_last_call: 2, max_memory_usage_since_last_call: 1 },
    });
    expect(one('table', { label: 'T', entries: [['a', serialize('<x>')], ['b', serialize(2)], ['c', serialize({ d: 1 })]] })).toMatchObject({
      type: 'table',
      content: { label: 'T', values: { a: '&lt;x&gt;', b: 2, c: '{&quot;d&quot;:1}' } },
    });
    expect(one('cmd', { cmd: 'new_screen', name: 'S' })).toMatchObject({ type: 'new_screen', content: { name: 'S' } });
    expect(one('cmd', { cmd: 'clear' })).toMatchObject({ type: 'clear_all', content: {} });
    expect(one('cmd', { cmd: 'notify', text: 'hi' })).toMatchObject({ type: 'notify', content: { value: 'hi' } });
    expect(one('cmd', { cmd: 'screen_color', color: 'red' })).toMatchObject({ type: 'screen_color', content: { color: 'red' } });
    expect(one('cmd', { cmd: 'confetti' })).toMatchObject({ type: 'confetti', content: {} });
    expect(one('http', { method: 'GET', url: '/x' })).toMatchObject({ type: 'custom', content: { label: 'http' } });
  });

  it("wire: 'ray' posts one envelope per entry to POST / with the Ray user agent", async () => {
    const t = makeRay();
    t.ray.configure({ wire: 'ray', project: 'shop' });
    t.ray('a').red();
    t.ray().text('b');
    await t.ray.flush();
    expect(t.gets).toEqual([]); // no hello in Ray mode
    expect(t.posts.map((p) => p.url)).toEqual(['http://localhost:23517/', 'http://localhost:23517/']);
    expect(t.posts[0]!.headers['User-Agent']).toBe('Ray 1.0 (gaze-js/test)');
    const [a, b] = t.envelopes();
    expect(a.payloads.map((p: any) => p.type)).toEqual(['log', 'color']);
    expect(a.meta.project_name).toBe('shop');
    expect(b.payloads[0].content.label).toBe('Text');
    expect(a.uuid).not.toBe(b.uuid);
  });

  it("wire: 'auto' falls back to Ray when GET /v1/hello is not a v1 hello", async () => {
    const t = makeRay({ get: async () => ({ status: 404 }) });
    t.ray.configure({ wire: 'auto' });
    t.ray('x');
    await t.ray.flush();
    expect(t.posts[0]!.url).toBe('http://localhost:23517/');
    expect(t.envelopes()[0].payloads[0]).toMatchObject({ type: 'log', content: { values: ['x'] } });
  });

  it('browsers post Ray envelopes with no-cors (target CORS support unknown)', async () => {
    const t = makeRay({ type: 'text/plain;charset=UTF-8' });
    t.ray.configure({ wire: 'ray' });
    t.ray('x');
    await t.ray.flush();
    expect(t.posts[0]).toMatchObject({ noCors: true, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
  });
});
