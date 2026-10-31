import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { repo } from './helpers.js';
import type { Entry as GeneratedEntry } from '../src/generated/batch.js';
import { hex, rand, traceId, uuid7 } from '../src/core/ids.js';
import type { WireEntry } from '../src/core/types.js';
import * as noop from '../src/noop.js';
import { VERSION } from '../src/version.js';
import { envDefaults } from '../src/platform/node.js';

describe('ids', () => {
  it('uuid7: version 7, variant 10, time-ordered, unique', () => {
    const a = uuid7(1_700_000_000_000);
    const b = uuid7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13).replace('-', '')).toBe((1_700_000_000_000).toString(16).padStart(12, '0'));
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => uuid7())).size).toBe(1000);
    expect(traceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('falls back to Math.random when crypto is missing (non-secure contexts have getRandomValues, but not always crypto)', () => {
    const d = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(hex(rand(8))).toMatch(/^[0-9a-f]{16}$/);
      expect(uuid7()).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', d);
    }
  });
});

describe('noop', () => {
  it('is chainable, returns values from pass(), resolves promises, sends nothing', async () => {
    const r = noop.ray('x', { y: 1 }).blue().label('l').text('t').table({}).exception(new Error());
    expect(r).toBe(noop.ray);
    expect(noop.ray().pass(5)).toBe(5);
    expect(noop.ray().counterValue('a')).toBe(0);
    expect(noop.ray.enabled()).toBe(false);
    await expect(noop.ray.flush()).resolves.toBeUndefined();
    await expect(noop.ray().pause()).resolves.toBe('released');
    const stop = await noop.ray.capture();
    expect(typeof stop).toBe('function');
    expect(noop.ray.watch(() => 1)).toBeTypeOf('function');
    expect((noop.ray as any).then).toBeUndefined(); // not a thenable: `await ray()` is safe
    expect(noop.gaze).toBe(noop.ray);
    expect(noop.dump).toBe(noop.ray);
    expect(noop.ray.at$('f', 1, 1)('x').red()).toBe(noop.ray);
    await expect(noop.ray().die()).resolves.toBeUndefined();
  });

  it("still runs the app's own code: group() returns its result, measure(fn) calls fn", async () => {
    expect(noop.ray.group('g', () => 42)).toBe(42);
    let ran = 0;
    expect(noop.ray().measure(() => ran++)).toBe(noop.ray);
    noop.ray().measure(async () => {
      ran++;
      throw new Error('settled, as when timed');
    });
    expect(ran).toBe(2);
  });
});

describe('package', () => {
  it('VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
    expect(pkg.name).toBe('@thewonderjoy/gaze-js');
    expect(pkg.dependencies ?? {}).toEqual({}); // zero runtime dependencies
    expect(pkg.sideEffects).toEqual(['./dist/auto.js', './dist/auto-node.js']);
    const dot = pkg.exports['.'];
    expect(Object.keys(dot)).toEqual(['types', 'production', 'workerd', 'edge-light', 'browser', 'deno', 'bun', 'node', 'default']);
    // A production build (a bundler resolving the `production` condition) gets the no-op only.
    expect(dot.production).toBe('./dist/noop.js');
    expect(pkg.exports['./auto'].production).toBe('./dist/noop.js');
  });

  it('src/generated/batch.ts is an exact copy of protocol/generated/batch.d.ts', () => {
    const copy = readFileSync(new URL('../src/generated/batch.ts', import.meta.url), 'utf8');
    const header = copy.slice(0, copy.indexOf('\n') + 1);
    expect(header).toContain('Copy of protocol/generated/batch.d.ts');
    expect(copy).toBe(header + readFileSync(repo + 'protocol/generated/batch.d.ts', 'utf8'));
  });

  it('WireEntry is assignable to the generated protocol Entry type (checked by tsc)', () => {
    const toGenerated = (e: WireEntry): GeneratedEntry => e;
    const e: WireEntry = { op: 'add', id: 'abcdefgh', seq: 0, kind: 'log', body: { values: [] }, color: 'red' };
    expect(toGenerated(e)).toBe(e);
    expectTypeOf(e.color).toEqualTypeOf<'green' | 'orange' | 'red' | 'purple' | 'blue' | 'gray' | undefined>();
  });
});

describe('Node env defaults', () => {
  it('GAZE_* then RAY_*; NODE_ENV=production disables unless GAZE_ENABLED', () => {
    const env = process.env;
    const keep = { ...env };
    try {
      for (const k of ['GAZE_HOST', 'GAZE_PORT', 'RAY_HOST', 'RAY_PORT', 'GAZE_ENABLED', 'NODE_ENV', 'GAZE_WIRE', 'GAZE_TOKEN']) delete env[k];
      Object.assign(env, { RAY_HOST: 'ray-host', RAY_PORT: '1234', GAZE_PORT: '2345', NODE_ENV: 'production' });
      expect(envDefaults()).toEqual({ host: 'ray-host', port: 2345, enabled: false });
      Object.assign(env, { GAZE_HOST: 'gaze-host', GAZE_ENABLED: 'true', GAZE_WIRE: 'ray' });
      expect(envDefaults()).toEqual({ host: 'gaze-host', port: 2345, enabled: true, wire: 'ray' });
      env.GAZE_ENABLED = '0';
      expect(envDefaults().enabled).toBe(false);
    } finally {
      for (const k of Object.keys(env)) if (!(k in keep)) delete env[k];
      Object.assign(env, keep);
    }
  });
});
