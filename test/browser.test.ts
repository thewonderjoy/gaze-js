// The browser platform reads location/document/navigator at import time, so each case stubs the
// globals and imports a fresh copy of the module.
import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(page: string, perm?: string) {
  vi.resetModules();
  const listeners: Record<string, Function[]> = {};
  const query = vi.fn(async (d: { name: string }) => {
    if (d.name != 'loopback-network') throw new TypeError('unknown permission');
    return { state: perm };
  });
  vi.stubGlobal('location', new URL(page));
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {} });
  vi.stubGlobal('navigator', { permissions: { query }, sendBeacon: vi.fn(() => true) });
  vi.stubGlobal('addEventListener', (t: string, fn: Function) => (listeners[t] ??= []).push(fn));
  const m = await import('../src/platform/browser.js');
  const fire = (t: string) => listeners[t]?.forEach((f) => f());
  return { ...m, query, fire, listeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Local Network Access gate', () => {
  it('loopback and *.test pages, or non-loopback targets, never query the permission', async () => {
    for (const page of ['http://localhost:5173/', 'http://127.0.0.1:8000/', 'https://shop.test/', 'http://app.localhost/']) {
      const b = await load(page, 'denied');
      await expect(b.lnaGate('localhost')).resolves.toBe(true);
      expect(b.query).not.toHaveBeenCalled();
    }
    const b = await load('https://staging.example.com/', 'denied');
    await expect(b.lnaGate('relay.example.com')).resolves.toBe(true);
    expect(b.query).not.toHaveBeenCalled();
  });

  it("queries 'loopback-network' (never the legacy name); denied gives up with one hint", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = await load('https://staging.example.com/', 'denied');
    await expect(b.lnaGate('localhost')).resolves.toBe(false);
    expect(b.query).toHaveBeenCalledWith({ name: 'loopback-network' });
    expect(b.query.mock.calls.flat().some((d: any) => d.name == 'local-network-access')).toBe(false);
    await b.lnaGate('localhost');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('loopback-network permission denied for https://staging.example.com');
  });

  it("'prompt' waits for the first user gesture; 'granted' goes straight through", async () => {
    const b = await load('https://xyz.ngrok.app/', 'prompt');
    let done = false;
    const p = b.lnaGate('127.0.0.1').then((v) => (done = v));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    b.fire('pointerdown');
    await p;
    expect(done).toBe(true);
    const g = await load('https://xyz.ngrok.app/', 'granted');
    await expect(g.lnaGate('localhost')).resolves.toBe(true);
  });
});

describe('browser fetch transport', () => {
  it('POSTs text/plain (no preflight), omits credentials, low priority; Ray mode uses no-cors', async () => {
    const b = await load('https://staging.example.com/');
    const fetch = vi.fn(async () => ({ type: 'cors', status: 202 }));
    vi.stubGlobal('fetch', fetch);
    await expect(b.browser.post('http://localhost:23517/v1/batch', '{}', { 'Content-Type': b.browser.type }, false)).resolves.toBe(202);
    expect(fetch.mock.calls[0]).toEqual([
      'http://localhost:23517/v1/batch',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        credentials: 'omit',
        mode: 'cors',
        priority: 'low',
        targetAddressSpace: 'loopback',
      }),
    ]);
    fetch.mockResolvedValueOnce({ type: 'opaque', status: 0 });
    await expect(b.browser.post('http://localhost:23517/', '{}', {}, true)).resolves.toBe(202);
    expect((fetch.mock.calls[1] as any)[1].mode).toBe('no-cors');
    expect(b.browser.runtime).toBe('browser');
    expect(b.browser.beacon!('u', 'b')).toBe(true);
  });
});
