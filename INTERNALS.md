# gaze-js internals

How the client works inside. For using it, see [README.md](README.md).

## Exports and conditions

| Import | File | What |
|---|---|---|
| `@thewonderjoy/gaze-js` | `node` / `bun` / `deno` conditions: `dist/node.js`; `browser` and `default`: `dist/browser.js`; `workerd` / `edge-light`: `dist/edge.js` | `ray`, `gaze`, `dump`, default export `ray`, classes `Ray` and `RateLimiter`, types |
| `/auto` | `node` / `bun` / `deno`: `dist/auto-node.js`; otherwise `dist/auto.js` | Side-effect import that installs capture: console, errors and network, plus request traces and SQL in the Node build. The only entries listed in `sideEffects`. In npm, pnpm and yarn's own processes (reached through `NODE_OPTIONS`) the Node build installs nothing. |
| bin `gaze-js` | `dist/bin.js` | `gaze-js run -- <command>` runs the command with `NODE_OPTIONS=--import=<file URL of dist/auto-node.js>`, so every Node process it starts loads capture. A file URL needs no quoting on Windows and works from any working directory. Not `gaze`: that npm name is an unrelated file watcher, which `npx gaze` would fetch. |
| `/vite` | `dist/vite.js` | Vite plugin |
| `/noop` | `dist/noop.js` | Same exports, every call does nothing |
| `/vue`, `/react`, `/svelte` | `dist/adapters/*.js` | Adapters. They import the package itself, so they share the instance your own `import { ray }` gets. |
| `/global` | `dist/gaze.global.js` | Minified IIFE. Sets `globalThis.ray`, `gaze` and `dump` only if undefined, and always `globalThis.Gaze`. |

CommonJS works through Node's `require(esm)`. The package has no top-level await, so this never throws `ERR_REQUIRE_ASYNC_MODULE`.

## Calls and batching

`ray(x).blue().label('a')` is one entry in one HTTP request. Calls made in the same tick share a request. Every method returns the same `Ray` except `pass()`, `counterValue()`, `pause()` and `die()`.

- A table of plain objects becomes a column table. Objects, Maps and arrays become key/value tables.
- Input the app would reject (labels over 200 characters, unknown colors, fractional expand levels, kinds with capitals) is normalized or dropped here, because one bad entry makes the app reject its whole batch.
- `once` and `limit` key on the call site (file:line:col). `count` keeps one entry per name and updates it.
- `exception` uses the error's own `err.stack`, follows `err.cause` (sent as `previous`), and lists `AggregateError.errors`.
- `measure(fn)` times sync and async functions; in Node it adds heap usage.
- `pause()` returns a promise. Native mode long-polls `GET /v1/locks/{id}?wait=25`; Ray mode polls `GET /locks/{name}` every second. It resolves `'released'` or `'stopped'`, and resolves `'released'` at once if the app is unreachable. It never blocks the event loop.
- `die()` flushes, then exits the process (Node, Bun, Deno) or rejects (browsers). Disabled, it resolves and does nothing.
- `ray.at(id).append(item)` adds an iteration to an entry. `ray('x').id` is the entry id.

## Off

Off is decided once, when the entry loads, and then the entry exports the no-op (`src/noop.ts`, one Proxy):

| Where | Off when | What loads |
|---|---|---|
| A bundler that applies the `production` export condition (Vite, webpack, Next.js with Turbopack or webpack) | a production build | `dist/noop.js` only, for `.` and `/auto` |
| `src/browser.ts`, `src/edge.ts` | `process.env.NODE_ENV === 'production'` as the app's bundler fills it in | the entry's chunks, but no client is created |
| `src/node.ts` | `GAZE_ENABLED=false`, or `NODE_ENV=production` without `GAZE_ENABLED=true` | the same (plain Node applies no `production` condition unless run with `--conditions=production`) |

ESM cannot load the real entry conditionally without top-level await, and that would break `require()` from CommonJS (NestJS). So in Node the client's modules are parsed, but none of their code runs: their top level only defines things (the hostname and the AsyncLocalStorage are made on first use), and nothing calls into them. `/auto` installs nothing and `gaze-js run` adds no `--import`.

The no-op still runs the app's own code: `group()` returns `fn()`, `measure(fn)` calls `fn` (settling a rejection, as when timed), `pass()` returns its value.

A disabled client (`enabled: false`, `disable()`) is paused, not gone: `die()` returns, `capture()` and `group()` install and record nothing, `flush()` sends nothing, and `enable()` resumes it.

Our own build keeps `process.env.NODE_ENV` as written (`define` to itself in `tsdown.config.ts`): rolldown's browser platform would bake in `"development"`.

## Configuration in full

| Option | Default | Notes |
|---|---|---|
| `host`, `port` | `localhost`, `23517` | Node reads `GAZE_HOST` / `GAZE_PORT`, then `RAY_HOST` / `RAY_PORT` |
| `url` | | Base URL that replaces host and port, for a same-origin relay such as `https://app.test/_gaze` |
| `wire` | `native` | `native`, `ray` or `auto` (`GET /v1/hello` decides). Node: `GAZE_WIRE` |
| `enabled` | `true` | Pauses and resumes sending (also `disable()` / `enable()`). Off by the environment is the no-op instead (below) |
| `project` | | Name, or `{ name, root, dev_server }` for path mapping |
| `token` | | Sent as `Authorization: Bearer` to non-loopback hosts only. Node: `GAZE_TOKEN` |
| `limits` | depth 8, 200 items, 5,000 nodes, 16 KiB strings | `hello.limits` can lower them |
| `origin` | `true` | `false` skips the stack capture on each call |
| `queue` | 500 entries, 5 MB | Drop-oldest queue while the app is down |
| `propagate` | | Origins that also get a `traceparent` on captured calls (they must allow it in CORS) |
| `bridge` | | Replaces HTTP, used by the Vite plugin |

In Deno the client reads env vars and the hostname only when that permission is already granted, so importing it never triggers a prompt.

## Wire modes

Native mode sends one batch per tick to `POST /v1/batch`, after a `GET /v1/hello` handshake that also brings limits and redaction patterns. Ray mode sends one Spatie Ray envelope per entry to `POST /`, with the modifiers in the same request, so nothing arrives out of order. In Node the User-Agent is `Ray 1.0 (gaze-js/<version>)`, which Buggregator needs to recognize Ray traffic.

In Ray mode values travel as plain JSON or text, never as HTML built from regexes. Strings and numbers go in `log` payloads. Booleans and null become `custom` Boolean / Null. Objects become `json_string`. Text is HTML-escaped because Ray renders `custom` content as HTML. Markdown and Mermaid use Ray 3's `ai_custom_markdown` and `ai_custom_mermaid`. The encoder loads on demand, so it costs nothing in native mode.

## Transport

- Node, Bun and Deno use global `fetch`, which keeps connections alive. The hello request times out after 1 s, so a script exits promptly when the app is closed. A pending send keeps Node alive until it finishes, and a `beforeExit` hook flushes what is left.
- Browsers POST `text/plain;charset=UTF-8` with `credentials: 'omit'` and `priority: 'low'`. That is a CORS simple request, so there is no preflight. Ray mode adds `mode: 'no-cors'`.
- On `pagehide`, queued entries go out through `navigator.sendBeacon`, at most 64 KiB in total.
- While the app is down the client retries after 1, 2, 4 … up to 30 seconds, with a drop-oldest queue. When it reconnects it adds one entry saying how many entries it dropped. A 429 or 5xx is retried; any other 4xx is dropped with one console hint.
- Hints use the console as it was before any capture module patched it.
- Local Network Access (Chrome 142+, Firefox 151+): when a public page talks to localhost, the client queries the `loopback-network` permission (never `local-network-access`, which can crash older renderers). On `prompt` it waits for the first click or key press. On `denied` it stops and prints one hint. Pages on localhost, `*.localhost`, loopback IPs and `*.test` skip the check.

## Vite plugin in full

In `vite dev` the plugin:

- injects the client into `index.html` and into the build input modules, which covers Laravel's Blade pages where `transformIndexHtml` never runs,
- sends browser batches over the HMR WebSocket (`gaze:batch`), and the dev server forwards them to the app from Node,
- relays `pause()` locks over the same socket,
- maps origins and stack frames in those batches from served URLs to source files and lines (below),
- does the `GET /v1/hello` handshake and logs the result,
- sends `project.root` and the dev server URL with every batch (the app does not use them yet),
- forwards Vite compile errors (`vite:error`).

The app trusts what the dev server forwards like any local process, so the bridge takes batches from whoever can open the HMR socket: this machine, plus the LAN when the server runs with `--host` (phones, Sail/Docker), which can already read the source from that server. Other websites cannot: Vite 6.0.9 and later (the peer range) require the socket token that only pages from the dev server get. A lock id must be one path segment (`[\w.:-]{8,64}`, URL-encoded) before the dev server polls it.

In `vite build` it aliases the package and `/auto` to `/noop` (about 400 bytes gzipped), which the `production` export condition does anyway.

| Option | Default | |
|---|---|---|
| `host`, `port`, `url`, `wire`, `token`, `enabled` | as above | Where the dev server forwards to |
| `project` | root folder name | |
| `inject` | `true` | |
| `entries` | | Extra modules to inject into |
| `bridge` | `true` | `false` makes the browser post directly |
| `capture` | `false` | `true` or `{ console, errors, network }` |
| `viteErrors` | `true` | |
| `callSites` | `false` | See below |
| `noopInBuild` | `true` | `false` keeps the client in builds with `NODE_ENV` other than `production` |
| `apply` | `'serve'` | |

**Source mapping.** A browser stack names the served URL (`http://localhost:5173/src/App.vue?t=171`) and the line of the transformed module, which no editor can open. Before the dev server forwards a bridged batch, it rewrites each entry's `origin` (and `origin.frames`) and the frames of `exception` bodies (with the `previous` chain) and `trace` bodies:

- A URL is this server's when it is root-relative (`/src/App.vue`) or has the origin of one of the server's local or network URLs or `server.origin`. A loopback server also accepts the other loopback names on its port (`localhost`, `127.0.0.1`, `[::1]`), because Laravel's hot file can say `[::1]`. Query strings and hashes are dropped.
- The module comes from the client environment's module graph. Its `file` replaces the URL. The line and column go through its `transformResult.map` with Node's `module.SourceMap`, and the map's source path is resolved against the module's folder.
- The parsed map is cached per module and rebuilt when the module's `transformResult` changes (HMR). An invalidated module keeps its last map until it is served again, since that is the code the page still runs.
- Foreign URLs, `node_modules` (including `.vite/deps`), modules not in the graph and absolute paths under the root (call-site origins on Linux and macOS) are left alone. A module without a map keeps its served line. Nothing is marked as vendor.
- Batches are mapped in arrival order. On any error the batch goes out unchanged.

In Ray mode the batch is mapped before it is re-encoded as Ray envelopes. Ray envelopes the browser built itself (the browser configured with `wire: 'ray'`) are forwarded as they are. With `bridge: false` the browser posts to the app directly and nothing is mapped.

**Call-site transform** (`callSites: true`, opt-in because it rewrites your code): each `ray(` / `gaze(` / `dump(` call imported from this package becomes `(ray.at$?ray.at$("/abs/src/App.vue",42,7):ray)(`, so the app gets the original file, line and column with no stack capture at runtime, including inside `.vue` and `.svelte` script blocks. It parses with Vite 8's TypeScript-aware `parseAst` and only touches call expressions whose callee is an imported name. Files that fail to parse are left alone, which includes everything on Vite 6 and 7. Calls inside Vue and Svelte templates are not rewritten. Without the transform, origins come from a synchronous stack capture: exact in Node; in browsers the served URL and line, which the dev server maps back to the source file and line (see Source mapping above) when batches go over the bridge.

## Adapters in full

- Vue: `app.use(RayPlugin, { warnings: true })` sets `errorHandler` (and `warnHandler`). `useRay()` gives `watch(ref)` (re-sends one entry on change, using `toRaw`) and `props`.
- React: `rayRootOptions()` wires React 19 root error callbacks with `componentStack`. `<RayBoundary>` is an error boundary.
- Svelte 5: `rayInspect`, `rayInspector(label)` for `$inspect().with()`, `rayBoundary(name)` for `<svelte:boundary onerror>`, `rayHandleError` for SvelteKit.

Each adapter calls the previous handler, or the framework's default reporting, after it reports.

## Capture

`ray.capture()` and `import '@thewonderjoy/gaze-js/auto'` install these modules (the last two in Node only, from `capture-node.ts`, so the browser bundle does not carry them). In Node they install once per process: the copy loaded by `--import` and a copy a bundler put into the app (Next.js bundles server code) share `globalThis` state.

- **console** wraps `log`, `info`, `warn`, `error`, `debug`, `trace`, `table`, `dir` and `assert`. It always calls the original, ignores re-entrant calls, colors by level and sends at most 50 calls per second.
- **errors** listens for `error` (capture phase, so failed `<img>` and `<script>` loads count) and `unhandledrejection` in browsers and Deno. In Node, when no other handler exists, it reports an uncaught exception or unhandled rejection, flushes for up to 2 s, then exits with code 1 like Node would. With your own handlers it only observes through `uncaughtExceptionMonitor`. It also reports `process` warnings.
- **network** wraps `fetch` and `XMLHttpRequest` (method, URL, status, duration). In Node it also subscribes to the `http.client.*` diagnostics channels. Requests to the Gaze app itself are skipped. Calls to the app's own servers get a W3C `traceparent` (`00-<current trace or random>-<new span>-01`): same origin in browsers, because the header on a cross-origin call would need CORS; loopback and `*.test` hosts in Node, through `fetch` and `http.client.request.created` (Node 22.12+; older Node only reports the call); plus the `propagate` origins. A `traceparent` already present (set by the app or OpenTelemetry) is left alone. The span id is sent as the entry's `span_id`, and the core links the server trace whose parent is that span to this entry (`Trace.caller`).
- **requests** (`src/node/requests.ts`): the `http.server.request.start` diagnostics channel opens one trace per request (kind `http`, name `GET /path`) and enters it into an AsyncLocalStorage with `enterWith`. These channels use `publish()`, so `channel.bindStore()` never runs. Each request's and response's `emit` is also wrapped in `als.run()`: listeners run in the socket's context, and under Node 24's AsyncContextFrame a hand-written `req.on('data'/'end')` reader loses the request otherwise. Framework body parsers (Express 4/5, Fastify, Hono, Nest) already bind their callbacks. `http.server.response.finish`, or the response's `close` when the client went away first (`aborted: true`), sends the `request` summary row. An incoming `traceparent` gives the trace its parent (the caller's span id), never its id, as in gaze-laravel: requests of one distributed trace must not merge. Dev-server traffic opens no trace: `sec-fetch-dest` script, style, image, font and similar, plus `/@vite/`, `/@fs/`, `/_next/`, `/__nextjs…` and `/node_modules/` paths. `node:http2`, `Bun.serve` and `Deno.serve` publish no such channel.
- **queries** (`src/node/sql.ts`): mysql2 3.20+ and postgres.js 4+ publish TracingChannels (`mysql2:query`, `mysql2:execute`, `postgres:query`). postgres.js puts no parameter values in its channel context, so its rows keep `$1` in the SQL. `pg` and `better-sqlite3` publish nothing, so `Client.prototype.query` and the statement methods are patched. A `module.registerHooks` resolve hook (Node 22.15+ / 23.5+) loads and patches every copy the app resolves, including drivers nested inside other packages (Prisma's adapters bring their own `better-sqlite3`). Without the hook, only the project's own copy is patched. `Pool.connect` callbacks are bound to the caller's context, because a busy pool hands a freed client to the next waiter from inside the previous holder's callback. The body matches gaze-laravel's (`sql` with values filled in, `template`, `bindings`, `driver`, `time_ms`, `fingerprint`, `flags`), and so does the folding. Within a trace, when one SQL shape runs more than 3 times, the runs fold into the first entry (`executions[]`, flag `n+1`) and the rows already sent are removed. Each trace's open groups are flushed when the trace closes (request summary or `group()` end, through `Client.closers`).

**Origins in Node.** Console and network entries take the first frame outside `node_modules` and this package, so a framework's console wrapper (Next.js has two) is not reported as the origin. With no such frame they get no origin inside a trace, and outside one they are skipped: start-up banners and a dev server's own update check. Frames in generated code (Turbopack chunks, tsc or esbuild output) are mapped through the file's `sourceMappingURL` with Node's built-in `module.SourceMap`. Each file is read once, files under `node_modules` are never read, and Deno is skipped so no permission prompt appears. Exception frames outside `node_modules` are mapped the same way. When this package is bundled into one file with the app (own folder unknown), the frame after a `captureStackTrace` boundary is taken as the caller, without skipping by file. Query origins stop at thenables (Drizzle, Prisma) and pool callbacks, because V8's `at async` frames do not continue through them, so those queries often have no origin.

For `/auto`, pick modules with `globalThis.GAZE_CAPTURE = { console: false }`, or in Node with `GAZE_CAPTURE=errors,network,requests,queries`.

## Size

Measured with `pnpm size` (rolldown with its oxc minifier, gzip level 9). The core counts the entry plus every chunk it imports statically.

| Bundle | min | min+gzip | Budget |
|---|---|---|---|
| Browser core (`import { ray }`, full API, serializer, transport) | 24.3 KB | 9.8 KB | 5 KB, missed |
| Core + capture modules | 30.0 KB | 11.9 KB | 9 KB, missed |
| Ray-compat encoder (lazy, `wire: 'ray'` only) | 3.4 KB | 1.5 KB | |
| Vue / React / Svelte adapter | 0.8 / 1.0 / 0.5 KB | 0.49 / 0.55 / 0.32 KB | 1.5 KB each |
| `noop` | 0.63 KB | 0.41 KB | 0.5 KB |

The full API does not fit in 5 KB. The `Ray` class with about 70 chainable methods is the largest part (roughly 40 % of the core; minifiers keep public method names). The client and transport come next, then the value serializer (about 1.9 KB gzip). The Ray-compat encoder and the capture modules already load on demand.

## Differences from node-ray

The origin is captured synchronously, so it is never `/unknown-file.js:1`. Chained modifiers share one request instead of one each. `pause()` does not busy-wait and does not hang when the app is down. `exception()` uses the error's stack, not the call site's. Configuration works on Windows and through `configure()`. Values are not regex-built HTML. A project folder named `my-ray-app` keeps its frames. There is no fixed 50 ms sleep after each request, and `require()` works.

## Tests

The e2e project builds `gaze-serve` with `cargo build -p gaze-core --bin gaze-serve`, runs it on port 23620 with `--json`, and checks what arrives in both wire modes. It also runs the built package in child processes (ESM import, `require(esm)`, `NODE_ENV=production`, `GAZE_ENABLED=false` and `--conditions=production`, `gaze-js run` on and off, app down, `--import dist/auto-node.js` with a request) and loads the IIFE in a VM context.

`test/node-trace.test.ts` covers the Node parts against real `node:http` servers and fake drivers. Concurrent groups, request bodies over 64 KiB, aborted requests, `traceparent`, N+1 folding, a busy pool, the mysql2 and postgres.js channels, source-map mapping and console origins. The same behaviour against real Express 4/5, Fastify, Hono, Nest, Next.js, Prisma 7, Drizzle, `pg` and postgres.js is checked by the scripts in `dev/node-lab`.

`src/generated/batch.ts` is a copy of the monorepo's `protocol/generated/batch.d.ts`. Run `pnpm sync-protocol` after the schema changes; a unit test fails when they drift.

## TODO

- Alpine, Livewire and Inertia adapters.
- `group()` cannot follow async work in browsers, which have no AsyncLocalStorage. Entries from other code that runs while an async group is open join it. In Node, Bun and Deno each group follows its own async work.
- Request traces for `node:http2`, `Bun.serve` and `Deno.serve`.
- Query origins through ORM thenables and pool callbacks.
- Origins in webpack-bundled server code (`webpack-internal://` sources); Turbopack's are mapped.
