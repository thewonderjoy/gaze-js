// While Gaze is off nothing of the client runs: no exit, no capture, no request, no trace. The entries
// export the no-op when the environment (or a production build) says off.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRay, settle } from './helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('a disabled client', () => {
  it('does not exit, capture, group, flush or send', async () => {
    const exit = vi.fn();
    const t = makeRay({ exit });
    const ray = t.ray;
    ray.configure({ enabled: false });
    const [log, fetch] = [console.log, globalThis.fetch];

    await expect(ray('bye').die(3)).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();

    expect(await ray.capture({ console: true, network: true })).toBeTypeOf('function');
    expect(console.log).toBe(log);
    expect(globalThis.fetch).toBe(fetch);

    expect(ray.group('g', () => 42)).toBe(42);
    await ray.flush();
    ray('x').red().measure('t');
    let ran = 0;
    ray().measure(() => ran++);
    ray().measure(async () => {
      ran++;
      throw new Error('settled, as when timed');
    });
    expect(ran).toBe(2);
    expect(ray.watch(() => 1)).toBeTypeOf('function');
    await settle(10);
    expect(t.posts).toEqual([]);
    expect(t.gets).toEqual([]);

    ray.enable();
    await expect(ray('bye').die(3)).rejects.toThrow('die');
    expect(exit).toHaveBeenCalledWith(3);
  });
});

describe('the entries', () => {
  it('Node: GAZE_ENABLED=false, or NODE_ENV=production without GAZE_ENABLED=true, exports the no-op', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('GAZE_ENABLED', '');
    const off = await import('../src/node.js');
    expect(off.ray.disabled()).toBe(true);
    expect(off.ray('x').red()).toBe(off.ray);
    off.ray.enable();
    off.ray.configure({ enabled: true });
    expect(off.ray.enabled()).toBe(false);
    const log = console.log;
    await import('../src/auto-node.js');
    expect(console.log, '/auto installs nothing').toBe(log);

    vi.resetModules();
    vi.stubEnv('GAZE_ENABLED', 'true');
    const on = await import('../src/node.js');
    expect(on.ray.enabled()).toBe(true);
    on.ray.disable();

    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('GAZE_ENABLED', 'false');
    expect((await import('../src/node.js')).ray.disabled()).toBe(true);
  });

  it('browser and edge: a production build (NODE_ENV baked in) exports the no-op', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const m of [await import('../src/browser.js'), await import('../src/edge.js')]) {
      expect(m.ray.disabled()).toBe(true);
      expect(m.ray('x').label('y')).toBe(m.ray);
    }
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'development');
    expect((await import('../src/browser.js')).ray.enabled()).toBe(true);
  });
});
