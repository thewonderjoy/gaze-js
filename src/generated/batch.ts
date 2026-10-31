// Copy of protocol/generated/batch.d.ts. Do not edit; run `pnpm sync-protocol`.
/* Generated from protocol/schema/batch.schema.json. Do not edit by hand; run `pnpm --filter ./protocol types`. */

export type Entry = {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  /**
   * add: new entry (an existing id is treated as update). update: replace body, keep modifiers not given (Ray same-uuid semantics). patch: modifiers only, no body. append: add body as a new iteration of entry id (Ray ai_custom_html iterationOf semantics). remove: delete.
   */
  op: "add" | "update" | "patch" | "append" | "remove";
  /**
   * Client-generated entry id (UUID v4/v7). Stable across update/patch/append/remove.
   */
  id: string;
  /**
   * Per-session monotonic counter
   */
  seq: number;
  /**
   * Client clock, epoch ms (fractional allowed)
   */
  ts?: number;
  /**
   * Known kinds have a body schema below; unknown kinds are rendered as a generic JSON tree of body.
   */
  kind?: string;
  body?: {};
  label?: string;
  color?: Color;
  size?: "sm" | "md" | "lg";
  hidden?: boolean;
  expand?: {
    level?: number;
    paths?: string[];
  };
  origin?: Origin;
  trace?: Trace1;
  tags?: {
    [k: string]: string | number | boolean;
  };
  [k: string]: unknown;
} & {
  /**
   * add: new entry (an existing id is treated as update). update: replace body, keep modifiers not given (Ray same-uuid semantics). patch: modifiers only, no body. append: add body as a new iteration of entry id (Ray ai_custom_html iterationOf semantics). remove: delete.
   */
  op: "add" | "update" | "patch" | "append" | "remove";
  /**
   * Client-generated entry id (UUID v4/v7). Stable across update/patch/append/remove.
   */
  id: string;
  /**
   * Per-session monotonic counter
   */
  seq: number;
  /**
   * Client clock, epoch ms (fractional allowed)
   */
  ts?: number;
  /**
   * Known kinds have a body schema below; unknown kinds are rendered as a generic JSON tree of body.
   */
  kind?: string;
  body?: {};
  label?: string;
  color?: Color;
  size?: "sm" | "md" | "lg";
  hidden?: boolean;
  expand?: {
    level?: number;
    paths?: string[];
  };
  origin?: Origin;
  trace?: Trace1;
  tags?: {
    [k: string]: string | number | boolean;
  };
  [k: string]: unknown;
};
export type Color = "green" | "orange" | "red" | "purple" | "blue" | "gray";

/**
 * Native ingest protocol v1 (DRAFT, protocol/RFC-0001). Body of POST /v1/batch. Brand-neutral on purpose: no product name appears in any wire identifier.
 */
export interface Batch {
  /**
   * Protocol major version. Additive changes never bump it.
   */
  v: 1;
  client: Client;
  /**
   * One id per OS process (PHP/Node) or page load (browser). Entries are ordered by (session, seq).
   */
  session: string;
  trace?: Trace;
  /**
   * @minItems 1
   * @maxItems 5000
   */
  entries: [Entry, ...Entry[]];
  [k: string]: unknown;
}
export interface Client {
  /**
   * Package name, e.g. vendor/php or @scope/node
   */
  name: string;
  version: string;
  runtime: "php" | "node" | "bun" | "deno" | "browser" | "worker" | "edge" | "other";
  runtime_version?: string;
  /**
   * laravel, symfony, vue, react, ...
   */
  framework?: string;
  framework_version?: string;
  /**
   * Machine/container hostname
   */
  host?: string;
  pid?: number;
  project?: {
    name?: string;
    /**
     * Absolute project root as the client sees it (container/WSL path); used for path mapping and dev-server URL -> file mapping
     */
    root?: string;
    /**
     * Vite/dev server origin, browser and Vite plugin only
     */
    dev_server?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * Default unit-of-work for every entry in this batch; an entry may override it.
 */
export interface Trace {
  /**
   * W3C trace-id (16 bytes hex) so it can ride on a standard traceparent header
   */
  id: string;
  /**
   * Parent span id, or parent trace id for cross-unit links (job dispatched by request)
   */
  parent?: string;
  kind?: "http" | "job" | "command" | "test" | "schedule" | "browser" | "livewire" | "inertia" | "other";
  name?: string;
  /**
   * epoch ms
   */
  started_at?: number;
  /**
   * true on the entry that closes the unit (summary row)
   */
  ended?: boolean;
  [k: string]: unknown;
}
export interface Origin {
  /**
   * Path as seen by the client (or a URL for browser code before mapping)
   */
  file?: string;
  line?: number;
  col?: number;
  function?: string;
  class?: string;
  /**
   * Optional 'called from' chain (top N app frames)
   *
   * @maxItems 50
   */
  frames?: Frame[];
  [k: string]: unknown;
}
export interface Frame {
  file: string;
  line: number;
  col?: number;
  function?: string;
  class?: string;
  vendor?: boolean;
  snippet?: {
    line: number;
    text: string;
  }[];
  [k: string]: unknown;
}
export interface Trace1 {
  /**
   * W3C trace-id (16 bytes hex) so it can ride on a standard traceparent header
   */
  id: string;
  /**
   * Parent span id, or parent trace id for cross-unit links (job dispatched by request)
   */
  parent?: string;
  kind?: "http" | "job" | "command" | "test" | "schedule" | "browser" | "livewire" | "inertia" | "other";
  name?: string;
  /**
   * epoch ms
   */
  started_at?: number;
  /**
   * true on the entry that closes the unit (summary row)
   */
  ended?: boolean;
  [k: string]: unknown;
}
