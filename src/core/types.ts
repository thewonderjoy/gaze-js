// Wire types of protocol v1 (protocol/RFC-0001). Batch, Client, Trace, Origin, Frame and Color come
// from the generated protocol types; Value and the entry shape are written out here because the
// generator cannot express them usefully (see test/types.test.ts for the compatibility check).
import type { Client, Color, Frame, Origin, Trace } from '../generated/batch.js';

export type { Batch, Client, Color, Frame, Origin, Trace } from '../generated/batch.js';

/** RFC-0001 §5.1 value node. */
export type Value =
  | { k: 'null' }
  | { k: 'undef' }
  | { k: 'bool'; v: boolean }
  | { k: 'int'; v: number | string }
  | { k: 'float'; v: number | 'NaN' | 'INF' | '-INF' | '-0' }
  | { k: 'str'; v: string; cut?: number; len?: number }
  | { k: 'const'; v: string }
  | { k: 'list'; cls?: string; count: number; items: Value[]; cut?: number; id?: number }
  | { k: 'map'; cls?: string; count: number; entries: [string | number | Value, Value][]; cut?: number; id?: number }
  | { k: 'obj'; cls: string; id?: number; props: Prop[]; cut?: number }
  | { k: 'ref'; to: number; cls?: string }
  | { k: 'fn'; name: string; async?: boolean; gen?: boolean }
  | { k: 'date'; iso: string }
  | { k: 'err'; name: string; message: string; stack?: string; cause?: Value }
  | { k: 'dom'; tag: string; attrs: Record<string, string>; html?: string };

export interface Prop {
  n: string;
  vis: 'pub' | 'prot' | 'priv' | 'dyn' | 'meta' | 'getter';
  val: Value;
}

export type Op = 'add' | 'update' | 'patch' | 'append' | 'remove';
export type Size = 'sm' | 'md' | 'lg';

/** Modifier fields of an entry (RFC-0001 §3). */
export type Mods = {
  label?: string;
  color?: Color;
  size?: Size;
  hidden?: boolean;
  expand?: { level?: number; paths?: string[] };
};

/** One entry on the wire (`Batch.entries[]`). A type alias, so it fits the generated `Entry`. */
export type WireEntry = Mods & {
  op: Op;
  id: string;
  seq: number;
  ts?: number;
  kind?: string;
  body?: Record<string, unknown>;
  origin?: Origin;
  trace?: Trace;
  tags?: Record<string, string | number | boolean>;
};

/** Serialization limits (RFC-0001 §4: depth 8, 200 items, 5,000 nodes, 16 KiB strings). */
export interface Limits {
  depth: number;
  items: number;
  nodes: number;
  string: number;
}

/** What a transport hook sees: a path on the app (`/v1/batch`, `/`) and a JSON body. */
export type Poster = (path: string, body: string) => Promise<number> | number;

/** Bridge transport (e.g. the Vite HMR socket). `lock` resolves a pause lock through the bridge. */
export interface Bridge {
  post: (path: string, body: string) => void;
  lock?: (id: string, ray: boolean) => Promise<LockState>;
}

export type LockState = 'active' | 'released' | 'stopped';
export type Wire = 'native' | 'ray' | 'auto';

export interface Options {
  /** Send anything at all. Node: false when NODE_ENV=production (unless GAZE_ENABLED=true). */
  enabled?: boolean;
  /** App host. Default `localhost` (Node: GAZE_HOST, then RAY_HOST). */
  host?: string;
  /** App port. Default 23517 (Node: GAZE_PORT, then RAY_PORT). */
  port?: number;
  /** Full base URL (e.g. a same-origin relay `https://app.test/_gaze`); overrides host/port. */
  url?: string;
  /** `native` (POST /v1/batch), `ray` (Spatie Ray v1 envelopes to POST /) or `auto` (GET /v1/hello decides). */
  wire?: Wire;
  /** Project name, or name + root (for path mapping) + dev server URL. */
  project?: string | { name?: string; root?: string; dev_server?: string };
  /** Bearer token; sent only to non-loopback hosts. */
  token?: string;
  /** Framework name/version shown as the client's framework. */
  framework?: string;
  framework_version?: string;
  /** Value tree limits. */
  limits?: Partial<Limits>;
  /** Capture the call site of each `ray()` call (one `new Error().stack` per call). Default true. */
  origin?: boolean;
  /** Replace the HTTP transport (e.g. Vite HMR bridge). */
  bridge?: Bridge | null;
  /** Bounded drop-oldest queue while the app is down. Default 500 entries / 5 MB. */
  queue?: { entries?: number; bytes?: number };
}

export interface ClientInfo extends Client {
  runtime: Client['runtime'];
}

export type { Frame as WireFrame };
