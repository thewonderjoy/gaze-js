# @thewonderjoy/gaze-js

Send values from JavaScript to the Gaze desktop app. Works in Node, Bun, Deno, browsers, workers and edge runtimes. Each value shows up with the file and line it came from.

Gaze is a fast debug window for PHP, Laravel and JavaScript (Windows first). It also accepts Spatie Ray's format, and this client can speak it too (`wire: 'ray'`), so it works with the Ray app and Buggregator as well.

![The Gaze window with a Vue component's props open in the inspector, next to the browser click that sent them and the server requests around it](art/gaze-js.png)

Node 20.19+ (22.12+ recommended). No runtime dependencies.

```bash
npm install @thewonderjoy/gaze-js
```

This is a normal dependency, as node-ray recommends, so a call you forgot to remove can't break production. In production you get a no-op instead of the client: every call does nothing (`die()` doesn't exit), nothing is patched or sent, and `enable()` can't switch it back on.

- **Node, Bun, Deno:** the package exports the no-op when `NODE_ENV=production` (unless `GAZE_ENABLED=true`) or `GAZE_ENABLED=false`. With `-D`, a server installed with `npm ci --omit=dev` would fail to start on the leftover `import`.
- **Browser and server bundles:** a production build contains only the no-op (about 0.4 KB). The package's `production` export condition points to it, and Vite, webpack and Next.js apply that condition. A bundler that doesn't apply it but sets `process.env.NODE_ENV` (esbuild when minifying) keeps the client but switches it off. With one that does neither, alias `@thewonderjoy/gaze-js` to `@thewonderjoy/gaze-js/noop` in production builds.

## Use

```js
import { ray } from '@thewonderjoy/gaze-js'; // `gaze` and `dump` are the same function

ray('order', order).blue().label('checkout');
ray().table(rows, 'Rows');
ray().exception(err);
await ray().pause(); // waits until you press Continue in the app
```

`require('@thewonderjoy/gaze-js')` works too.

Values are copied when you call `ray()`, so changing the object afterwards does not change what you logged. Short scripts don't need anything extra: pending sends finish before Node exits. Call `await ray.flush()` before `process.exit()`, and `ctx.waitUntil(ray.flush())` in edge handlers.

## Methods

Methods return the `Ray` instance, so calls chain: `ray(x).red().label('x')`. The names match Ray.

**Send something**

| Method | What it shows |
|---|---|
| `ray(...values)`, `send(...values)`, `raw(...values)` | One or more values in one entry. |
| `pass(value)` | Sends `value` and returns it: `return ray().pass(total);` |
| `text(text)` | Plain text. |
| `html(html)` | Rendered HTML, in a sandbox (scripts don't run). |
| `markdown(markdown)` | Rendered Markdown. |
| `mermaid(source)` | A Mermaid diagram. |
| `json(...jsonStrings)` | JSON strings, decoded and shown as trees. |
| `toJson(...values)` | Values as a JSON tree. |
| `xml(xml)` | XML. |
| `table(data, label?)` | An object, `Map` or array as a key/value table, or an array of objects as rows and columns. |
| `image(src)` | An image from a URL, a path or base64 data. |
| `date(date = now)` | A date (a `Date`, a timestamp or a string). |
| `className(value)` | The class of a value. |
| `separator()` | A divider line. |
| `exception(err, meta?)` | An error with its stack, `cause` chain and `AggregateError` members, in red. |
| `entry(kind, body)` | An entry of any kind, with a JSON body. |

**Change how it looks**

| Method | What it does |
|---|---|
| `green()` `orange()` `red()` `purple()` `blue()` `gray()`, `color(name)` | Colours the entry. `yellow()` is the same as `orange()`. |
| `small()`, `large()`, `size(size)` | Text size. |
| `label(text)` | Adds a label. |
| `hide()` | Shows the entry collapsed. |
| `expand()`, `expand(3)`, `expand('user.roles')` | Opens the value tree by levels or by key path. |
| `expandAll()` | Opens the whole tree. |
| `remove()` | Removes the entry from the app. |
| `showIf(condition)`, `showWhen(...)` | Keeps the entry only if the condition is true. |
| `removeIf(condition)`, `removeWhen(...)` | Removes the entry if the condition is true. |

**Decide when to send**

| Method | What it does |
|---|---|
| `if(condition)` | Later calls in this chain only send when the condition is true. |
| `if(condition, (r) => ...)` | Runs the callback when the condition is true. |
| `once(...values)` | Sends only the first time this line runs. |
| `limit(n)` | Sends at most `n` times from this line. |
| `count(name?)` | Counts how often this line (or this name) runs, in one entry. |
| `counterValue(name)`, `clearCounters()` | Reads or resets the counters. |
| `rateLimiter().max(n).perSecond(n)` | Caps how much is sent in total, or per second. `.clear()` resets it. |
| `enable()`, `disable()`, `enabled()`, `disabled()` | Turns sending on or off, or checks it. |
| `ray.macro(name, fn)` | Adds your own method: `ray.macro('double', function (n) { return this.send(n * 2) })`. |

**Debug**

| Method | What it does |
|---|---|
| `await pause()` | Waits until you press Continue in the app. Resolves at once if the app is closed. |
| `measure(name = 'default')` | A stopwatch: the first call starts it, later calls show total and lap time. |
| `measure(fn)` | Times a function, sync or async. |
| `stopTime(name?)` | Forgets one stopwatch, or all of them. |
| `trace(limit = 25)`, `backtrace(...)` | The stack trace from this line. |
| `caller()` | The function that called the current one. |
| `await die(code = 1)` | Sends everything, then exits (Node, Bun, Deno) or rejects (browsers). Does nothing while Gaze is off. |

**Control the app**

| Method | What it does |
|---|---|
| `newScreen(name = '')` | Starts a new, empty screen. |
| `clearScreen()` | Clears the current screen. |
| `clearAll()` | Clears all screens. |
| `screenColor(color)` | Colours the screen. |
| `showApp()`, `hideApp()` | Brings the window to the front, or hides it. |
| `notify(text)` | A desktop notification. |
| `confetti()` | Confetti. |
| `project(name)` | The project name for this and later entries. |

**Gaze only** (not in node-ray)

| Method | What it does |
|---|---|
| `ray.at(id)` | Targets a fixed entry id: `ray.at('cart').send(cart)` updates the same entry each time. |
| `ray().id` | The entry's id. |
| `append(...values)` | Adds to the entry instead of replacing it. |
| `ray.watch(() => value, { interval: 500 })` | Re-sends the value whenever it changes. Returns a stop function. |
| `ray.group(label, fn)` | Groups the entries made inside `fn` and returns its result. |
| `await ray.capture({ console, errors, network })` | Forwards console output, errors and `fetch` calls. In Node also `requests` and `queries` (see [Node servers](#node-servers)). Resolves to an uninstall function. |
| `await ray.flush()` | Sends everything queued. |
| `ray.configure(options)` | Changes settings (below). |

**From node-ray, not included:** `file()`, `event()`, `htmlMarkup()`, `chain()`, `ban()`, `charles()`, `error()` (use `exception()`), `sendCustom()` (use `entry()`), and `interceptor()` (use `ray.capture({ console: true })`).

## Imports

| Import | What |
|---|---|
| `@thewonderjoy/gaze-js` | `ray`, `gaze`, `dump`. Picks the Node, browser or edge build by itself. |
| `@thewonderjoy/gaze-js/auto` | Import once to forward console output, errors and network calls. In Node also request traces and SQL. |
| `@thewonderjoy/gaze-js/vite` | Vite plugin (below). |
| `@thewonderjoy/gaze-js/noop` | Same API, does nothing. For production builds. |
| `@thewonderjoy/gaze-js/vue` | `RayPlugin`, `useRay()` |
| `@thewonderjoy/gaze-js/react` | `useRay()`, `<RayBoundary>`, `rayRootOptions()` |
| `@thewonderjoy/gaze-js/svelte` | `rayInspect`, `rayInspector()`, `rayBoundary()` |
| `@thewonderjoy/gaze-js/global` | A script tag build that sets `window.ray` |

## Settings

`ray.configure(options)`:

| Option | Default | |
|---|---|---|
| `host`, `port` | `localhost`, `23517` | Node also reads `GAZE_HOST` / `GAZE_PORT`, then `RAY_HOST` / `RAY_PORT` |
| `wire` | `native` | `native` (Gaze), `ray` (Spatie Ray format) or `auto` |
| `enabled` | `true` | `false` pauses sending, and `ray.enable()` resumes it. Production (above) is the no-op, which no setting switches on |
| `project` | | a name, or `{ name, root }` |
| `url` | | send to a relay instead, for example `https://app.test/_gaze` |
| `propagate` | | extra origins whose requests get a `traceparent`, so a server request links to the call that made it. Same-origin calls (and local hosts in Node) always get it. The server must allow the header in CORS. |

If the app is closed, entries wait in a small queue and are sent when it comes back. Nothing ever throws into your code.

## Node servers

Start your server with the client preloaded, and each request shows up as its own group in the app. No code changes:

```bash
node --import @thewonderjoy/gaze-js/auto server.js
npx @thewonderjoy/gaze-js run -- npm run dev   # also covers every Node process the command starts
```

- **Requests.** One group per incoming HTTP request in Express, Fastify, Hono, NestJS, Next.js or plain `node:http`. Your `ray()` calls, console output, outgoing `fetch` calls, errors and queries land in it, and a summary row closes it with the status and duration.
- **SQL.** Queries from `pg`, `mysql2`, `postgres` and `better-sqlite3`, so also from Prisma 7, Drizzle, Kysely and Knex on top of them. When one query shape runs more than three times in a request, the runs fold into one N+1 row that lists every execution.
- **Less noise.** Console lines and network calls made by your dependencies outside any request, such as start-up banners and update checks, are left out.

Pick modules with `GAZE_CAPTURE=console,errors,network,requests,queries`.

**Next.js:** `npx @thewonderjoy/gaze-js run -- next dev` is all it takes. Route handlers, Server Components and the server render of Client Components each land in their request, and entries point at your own files.

Not covered: `node:http2` servers, `Bun.serve` and `Deno.serve`. Finding the drivers that other packages bring along (Prisma's adapters do) needs Node 22.15+. For queries run through an ORM, the file and line are often unknown.

## Vite plugin

```js
// vite.config.js
import gaze from '@thewonderjoy/gaze-js/vite';

export default { plugins: [gaze({ project: 'shop' })] };
```

In `vite dev` it adds the client to your pages (Laravel Blade pages too), sends browser entries through Vite's own connection (no CORS, works from a phone on your network), and forwards Vite compile errors to the app. Browser entries and errors point at your source files and lines, so "open in editor" works for them. In `vite build` it swaps the client for the no-op version, so production bundles send nothing.

## Framework adapters

```js
// Vue 3
import { RayPlugin } from '@thewonderjoy/gaze-js/vue';
app.use(RayPlugin);                      // Vue errors and warnings go to Gaze

// React 19
import { useRay, rayRootOptions } from '@thewonderjoy/gaze-js/react';
createRoot(el, rayRootOptions());        // React errors with the component stack
useRay(cart, { label: 'cart' });         // one entry, updated when `cart` changes

// Svelte 5
import { rayInspector } from '@thewonderjoy/gaze-js/svelte';
$inspect(cart).with(rayInspector('cart'));
```

## Without a bundler

```html
<script src="/vendor/gaze/gaze.global.js" data-port="23517"></script>
<script>ray('hello from a Blade page')</script>
```

## License

MIT
