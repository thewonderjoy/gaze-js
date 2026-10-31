import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import type { Platform } from '../src/core/client.js';
import { createRay } from '../src/core/ray.js';
import type { Value, WireEntry } from '../src/core/types.js';

export const repo = fileURLToPath(new URL('../../../', import.meta.url));
const schema = JSON.parse(readFileSync(repo + 'protocol/schema/batch.schema.json', 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(schema);
export const validateBatch = ajv.getSchema(schema.$id)!;
export const validateValue = ajv.getSchema(schema.$id + '#/$defs/Value')!;

/** Assert a Value node is valid per batch.schema.json#/$defs/Value. */
export function expectValidValue(v: Value): void {
  if (!validateValue(v)) throw new Error(`invalid Value ${JSON.stringify(v)}: ${JSON.stringify(validateValue.errors)}`);
}

export function expectValidBatch(b: unknown): void {
  if (!validateBatch(b)) throw new Error(`invalid batch: ${JSON.stringify(validateBatch.errors?.slice(0, 5))}\n${JSON.stringify(b).slice(0, 2000)}`);
}

export interface Post {
  url: string;
  body: string;
  headers: Record<string, string>;
  noCors: boolean;
}

export const HELLO = { v: 1, server: { name: 'test', version: '0' }, protocol: { min: 1, max: 1 }, features: ['batch'], limits: {} };

export function fakePlatform(over: Partial<Platform> = {}): { p: Platform; posts: Post[]; gets: string[] } {
  const posts: Post[] = [];
  const gets: string[] = [];
  const p: Platform = {
    runtime: 'node',
    version: '24.0.0',
    host: 'test-host',
    pid: 42,
    type: 'application/json',
    headers: (ray) => ({ 'User-Agent': ray ? 'Ray 1.0 (gaze-js/test)' : 'gaze-js/test' }),
    post: async (url, body, headers, noCors) => {
      posts.push({ url, body, headers, noCors });
      return 202;
    },
    get: async (url) => {
      gets.push(url);
      return { status: 200, json: HELLO };
    },
    ...over,
  };
  return { p, posts, gets };
}

/** A fresh ray() on a fake platform. */
export function makeRay(over: Partial<Platform> = {}) {
  const f = fakePlatform(over);
  const ray = createRay(f.p, {
    capture: () => import('../src/capture.js'),
    ray: () => import('../src/core/ray-wire.js').then((m) => m.rayEnvelope),
  });
  const batches = () => f.posts.filter((x) => x.url.endsWith('/v1/batch')).map((x) => JSON.parse(x.body));
  const entries = (): WireEntry[] => batches().flatMap((b) => b.entries);
  const envelopes = () => f.posts.filter((x) => !x.url.endsWith('/v1/batch')).map((x) => JSON.parse(x.body));
  return { ray, ...f, batches, entries, envelopes };
}

/** Let microtasks and pending async sends settle. */
export const settle = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 1-based line of the first line in `file` containing `marker`. */
export function lineOf(file: string, marker: string): number {
  const lines = readFileSync(file, 'utf8').split('\n');
  const i = lines.findIndex((l) => l.includes(marker));
  if (i < 0) throw new Error(`marker ${marker} not found`);
  return i + 1;
}
