// Node, Bun and Deno: global fetch (undici keeps connections alive), env defaults, hostname/pid,
// `beforeExit` flush. Deno: env and hostname are read only when already permitted, so importing this
// module never triggers a permission prompt.
import { hostname } from 'node:os';
import type { Platform } from '../core/client.js';
import type { Options, Wire } from '../core/types.js';
import { VERSION } from '../version.js';

const G = globalThis as Record<string, any>;
const P = G.process;
const D = G.Deno;
const B = G.Bun;

const allowed = (desc: object): boolean => {
  try {
    return !D || D.permissions.querySync(desc).state == 'granted';
  } catch {
    return false;
  }
};
const env = (k: string): string | undefined => (allowed({ name: 'env', variable: k }) ? P?.env?.[k] || undefined : undefined);

/** GAZE_HOST/GAZE_PORT, then RAY_HOST/RAY_PORT; GAZE_ENABLED; NODE_ENV=production disables. */
export function envDefaults(): Options {
  const o: Options = {};
  const host = env('GAZE_HOST') ?? env('RAY_HOST');
  if (host) o.host = host;
  const port = Number(env('GAZE_PORT') ?? env('RAY_PORT'));
  if (port > 0) o.port = port;
  const on = env('GAZE_ENABLED');
  if (on) o.enabled = !/^(0|false|off|no)$/i.test(on);
  else if (env('NODE_ENV') == 'production') o.enabled = false;
  const wire = env('GAZE_WIRE');
  if (wire == 'native' || wire == 'ray' || wire == 'auto') o.wire = wire as Wire;
  const token = env('GAZE_TOKEN');
  if (token) o.token = token;
  return o;
}

async function request(url: string, init: RequestInit, ms: number): Promise<[number, string]> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  // Read the body so undici can reuse the connection.
  return [res.status, await res.text()];
}

let host: string | undefined;
try {
  if (allowed({ name: 'sys', kind: 'hostname' })) host = hostname();
} catch {}

export const node: Platform = {
  runtime: B ? 'bun' : D ? 'deno' : 'node',
  version: B ? B.version : D ? D.version?.deno : P?.versions?.node,
  host,
  pid: P?.pid,
  defaults: envDefaults,
  type: 'application/json',
  headers: (ray) => ({ 'User-Agent': ray ? `Ray 1.0 (gaze-js/${VERSION})` : `gaze-js/${VERSION}` }),
  post: async (url, body, headers) => (await request(url, { method: 'POST', body, headers }, 10000))[0],
  get: async (url, headers, ms) => {
    const [status, text] = await request(url, { headers }, ms);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status, json };
  },
  onExit: (fn) => P?.on?.('beforeExit', fn),
  mem: () => P.memoryUsage().heapUsed,
  exit: (code) => P.exit(code),
};
