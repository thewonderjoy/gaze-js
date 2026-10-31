# gaze-js internals

How the client works inside. For using it, see [README.md](README.md).

## Exports and conditions

| Import | File | What |
|---|---|---|
| `@thewonderjoy/gaze-js` | `node` / `bun` / `deno` conditions: `dist/node.js`; `browser` and `default`: `dist/browser.js`; `workerd` / `edge-light`: `dist/edge.js` | `ray`, `gaze`, `dump`, default export `ray`, classes `Ray` and `RateLimiter`, types |
| `/auto` | `dist/auto.js` | Side-effect import that installs console, error and network capture. The only entry listed in `sideEffects`. |
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
- `die()` flushes, then exits the process (Node, Bun, Deno) or rejects (browsers).
- `ray.at(id).append(item)` adds an iteration to an entry. `ray('x').id` is the entry id.

## Configuration in full

| Option | Default | Notes |
|---|---|---|
| `host`, `port` | `localhost`, `23517` | Node reads `GAZE_HOST` / `GAZE_PORT`, then `RAY_HOST` / `RAY_PORT` |
| `url` | | Base URL that replaces host and port, for a same-origin relay such as `https://app.test/_gaze` |
| `wire` | `native` | `native`, `ray` or `auto` (`GET /v1/hello` decides). Node: `GAZE_WIRE` |
| `enabled` | `true` | Node: `false` when `NODE_ENV=production`, unless `GAZE_ENABLED=true` |
| `project` | | Name, or `{ name, root, dev_server }` for path mapping |
| `token` | | Sent as `Authorization: Bearer` to non-loopback hosts only. Node: `GAZE_TOKEN` |
| `limits` | depth 8, 200 items, 5,000 nodes, 16 KiB strings | `hello.limits` can lower them |
| `origin` | `true` | `false` skips the stack capture on each call |
| `queue` | 500 entries, 5 MB | Drop-oldest queue while the app is down |
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
- does the `GET /v1/hello` handshake and logs the result,
- sends `project.root` and the dev server URL with every batch, so the app can map `/src/x.ts` URLs to files,
- forwards Vite compile errors (`vite:error`).

In `vite build` it aliases the package and `/auto` to `/noop` (about 300 bytes).

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
| `noopInBuild` | `true` | |
| `apply` | `'serve'` | |

**Call-site transform** (`callSites: true`, opt-in because it rewrites your code): each `ray(` / `gaze(` / `dump(` call imported from this package becomes `(ray.at$?ray.at$("/abs/src/App.vue",42,7):ray)(`, so the app gets the original file, line and column with no stack capture at runtime, including inside `.vue` and `.svelte` script blocks. It parses with Vite 8's TypeScript-aware `parseAst` and only touches call expressions whose callee is an imported name. Files that fail to parse are left alone, which includes everything on Vite 6 and 7. Calls inside Vue and Svelte templates are not rewritten. Without the transform, origins come from a synchronous stack capture: exact in Node; in browsers the served URL and line, which the app maps through the dev server's source maps.

## Adapters in full

- Vue: `app.use(RayPlugin, { warnings: true })` sets `errorHandler` (and `warnHandler`). `useRay()` gives `watch(ref)` (re-sends one entry on change, using `toRaw`) and `props`.
- React: `rayRootOptions()` wires React 19 root error callbacks with `componentStack`. `<RayBoundary>` is an error boundary.
- Svelte 5: `rayInspect`, `rayInspector(label)` for `$inspect().with()`, `rayBoundary(name)` for `<svelte:boundary onerror>`, `rayHandleError` for SvelteKit.

Each adapter calls the previous handler, or the framework's default reporting, after it reports.

## Capture

`ray.capture()` and `import '@thewonderjoy/gaze-js/auto'` install three modules:

- **console** wraps `log`, `info`, `warn`, `error`, `debug`, `trace`, `table`, `dir` and `assert`. It always calls the original, ignores re-entrant calls, colors by level and sends at most 50 calls per second.
- **errors** listens for `error` (capture phase, so failed `<img>` and `<script>` loads count) and `unhandledrejection` in browsers and Deno. In Node, when no other handler exists, it reports an uncaught exception or unhandled rejection, flushes for up to 2 s, then exits with code 1 like Node would. With your own handlers it only observes through `uncaughtExceptionMonitor`. It also reports `process` warnings.
- **network** wraps `fetch` and `XMLHttpRequest` (method, URL, status, duration). In Node it also subscribes to the `http.client.*` diagnostics channels. Requests to the Gaze app itself are skipped.

For `/auto`, pick modules with `globalThis.GAZE_CAPTURE = { console: false }`, or in Node with `GAZE_CAPTURE=errors,network`.

## Size

Measured with `pnpm size` (rolldown with its oxc minifier, gzip level 9). The core counts the entry plus every chunk it imports statically.

| Bundle | min | min+gzip | Budget |
|---|---|---|---|
| Browser core (`import { ray }`, full API, serializer, transport) | 23.1 KB | 9.3 KB | 5 KB, missed |
| Core + capture modules | 26.9 KB | 10.8 KB | 9 KB, missed |
| Ray-compat encoder (lazy, `wire: 'ray'` only) | 3.4 KB | 1.5 KB | |
| Vue / React / Svelte adapter | 0.8 / 1.0 / 0.5 KB | 0.49 / 0.55 / 0.32 KB | 1.5 KB each |
| `noop` | 0.47 KB | 0.34 KB | |

The full API does not fit in 5 KB. The `Ray` class with about 70 chainable methods is the largest part (roughly 40 % of the core; minifiers keep public method names). The client and transport come next, then the value serializer (about 1.9 KB gzip). The Ray-compat encoder and the capture modules already load on demand.

## Differences from node-ray

The origin is captured synchronously, so it is never `/unknown-file.js:1`. Chained modifiers share one request instead of one each. `pause()` does not busy-wait and does not hang when the app is down. `exception()` uses the error's stack, not the call site's. Configuration works on Windows and through `configure()`. Values are not regex-built HTML. A project folder named `my-ray-app` keeps its frames. There is no fixed 50 ms sleep after each request, and `require()` works.

## Tests

The e2e project builds `gaze-serve` with `cargo build -p gaze-core --bin gaze-serve`, runs it on port 23620 with `--json`, and checks what arrives in both wire modes. It also runs the built package in child processes (ESM import, `require(esm)`, `NODE_ENV=production`, app down) and loads the IIFE in a VM context.

`src/generated/batch.ts` is a copy of the monorepo's `protocol/generated/batch.d.ts`. Run `pnpm sync-protocol` after the schema changes; a unit test fails when they drift.

## TODO

- Alpine, Livewire and Inertia adapters.
- Origins for Node `http` requests seen through diagnostics channels (they have none today).
- `group()` cannot follow async work in browsers, which have no AsyncLocalStorage. Entries from other code that runs while an async group is open join it.
