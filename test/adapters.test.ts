import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import { ray } from '@thewonderjoy/gaze-js';
import { RayPlugin, useRay } from '../src/adapters/vue.js';
import { RayBoundary, rayRootOptions } from '../src/adapters/react.js';
import { rayBoundary, rayHandleError, rayInspect, rayInspector } from '../src/adapters/svelte.js';
import type { WireEntry } from '../src/core/types.js';
import { expectValidBatch, lineOf } from './helpers.js';

const FILE = fileURLToPath(import.meta.url);
let sent: WireEntry[] = [];

// The adapters import "@thewonderjoy/gaze-js" itself (aliased to src/node.ts in vitest): capture its
// batches through a bridge instead of HTTP.
beforeEach(() => {
  sent = [];
  ray.configure({
    bridge: {
      post: (_p, b) => {
        const batch = JSON.parse(b);
        expectValidBatch(batch);
        sent.push(...batch.entries);
      },
    },
  });
});
afterEach(() => vi.restoreAllMocks());

describe('vue', () => {
  it('RayPlugin: $ray, provide, errorHandler that reports and keeps logging', async () => {
    const app = { config: { globalProperties: {} as any, errorHandler: undefined as any, warnHandler: undefined as any }, provide: vi.fn() };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    RayPlugin.install(app as any, { warnings: true });
    expect(app.config.globalProperties.$ray).toBe(ray);
    expect(app.provide).toHaveBeenCalledWith('ray', ray);
    app.config.errorHandler(new TypeError('boom'), { $: { type: { __name: 'Checkout' } } }, 'setup function');
    app.config.warnHandler('bad prop', null, '\n  at <App>');
    await ray.flush();
    expect(error).toHaveBeenCalledOnce();
    const [ex, warn] = sent;
    expect(ex).toMatchObject({ kind: 'exception', color: 'red', body: { class: 'TypeError', message: 'boom' } });
    expect((ex!.body as any).context.props.map((p: any) => [p.n, p.val.v])).toEqual([
      ['info', 'setup function'],
      ['component', 'Checkout'],
    ]);
    expect(warn).toMatchObject({ kind: 'text', label: 'vue warn', color: 'orange' });
  });

  it('useRay().watch sends reactive values (toRaw) to one entry, updated in place', async () => {
    const n = ref(1);
    const state = reactive({ items: [1] });
    const { watch: w } = useRay();
    const stop = w(n, 'n'); // @vue-watch
    const stop2 = w(state);
    n.value = 2;
    state.items.push(2);
    await nextTick();
    await ray.flush();
    stop();
    stop2();
    const nEntries = sent.filter((e) => e.label == 'n' || e.id == sent[0]!.id);
    expect(new Set(nEntries.map((e) => e.id)).size).toBe(1);
    expect(nEntries.map((e) => (e.body as any).values[0].v)).toEqual([1, 2]);
    expect(nEntries[0]!.origin!.line).toBe(lineOf(FILE, '@vue-watch'));
    const items = sent.filter((e) => e.id != sent[0]!.id).at(-1)!;
    expect((items.body as any).values[0]).toMatchObject({ k: 'obj', cls: 'Object', props: [{ n: 'items', val: { k: 'list', count: 2 } }] });
  });
});

describe('react', () => {
  it('RayBoundary reports with the component stack and renders the fallback', async () => {
    const b = new RayBoundary({ children: 'ok', fallback: 'oops', label: 'Shop' });
    expect(b.render()).toBe('ok');
    b.state = RayBoundary.getDerivedStateFromError(new Error('x'));
    b.componentDidCatch(new Error('render failed'), { componentStack: '\n    at Cart' } as any);
    expect(b.render()).toBe('oops');
    await ray.flush();
    expect(sent[0]).toMatchObject({ kind: 'exception', label: 'Shop', body: { message: 'render failed' } });
    expect((sent[0]!.body as any).context.props[0]).toMatchObject({ n: 'componentStack', val: { v: '\n    at Cart' } });
  });

  it('rayRootOptions reports every root error kind and keeps the previous handler', async () => {
    const mine = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const o = rayRootOptions({ onCaughtError: mine });
    o.onCaughtError(new Error('caught'), { componentStack: 'stack' });
    o.onRecoverableError(new Error('recoverable'), {});
    await ray.flush();
    expect(mine).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(sent.map((e) => (e.body as any).message)).toEqual(['caught', 'recoverable']);
  });
});

describe('svelte', () => {
  it('rayInspect / rayInspector / rayBoundary / rayHandleError', async () => {
    rayInspect('init', 1, 'a');
    const insp = rayInspector('cart');
    insp('init', { n: 1 });
    await ray.flush();
    insp('update', { n: 2 });
    const next = vi.fn();
    rayBoundary('Checkout', next)(new Error('b'), () => {});
    expect(rayHandleError({ error: new Error('k'), status: 500, event: { url: new URL('https://x.test/a'), route: { id: '/a' } } })).toEqual({ message: 'Internal Error' });
    await ray.flush();
    expect(next).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({ label: '$inspect init', body: { values: [{ k: 'int', v: 1 }, { k: 'str', v: 'a' }] } });
    const cart = sent.filter((e) => e.label == 'cart' || e.id == sent[1]!.id);
    expect(cart.map((e) => e.op)).toEqual(['add', 'update']);
    expect(cart[1]).toMatchObject({ color: 'blue' });
    expect(sent.find((e) => e.label == 'Checkout')).toMatchObject({ kind: 'exception' });
    expect(sent.find((e) => e.label == 'SvelteKit')).toMatchObject({ kind: 'exception', body: { message: 'k' } });
  });
});
