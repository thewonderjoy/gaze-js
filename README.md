# @thewonderjoy/gaze-js

Send values from JavaScript to the Gaze desktop app. Each one shows up with the file and line that sent it. Works in Node, Bun, Deno, browsers, web workers and edge runtimes.

Gaze is a desktop debug window for PHP, Laravel and JavaScript apps, on Mac, Windows and Linux.

**Get the app:** download Gaze from [thewonderjoy.com/products/gaze](https://thewonderjoy.com/products/gaze).

![The Gaze window with a Vue component's props open in the inspector, next to the browser's Update cart action that sent them and the Node API request it made, with that request's SQL queries, shown half in the light theme and half in the dark theme](https://raw.githubusercontent.com/thewonderjoy/gaze-js/main/art/gaze-js.png)

## Install

```bash
npm install @thewonderjoy/gaze-js
```

pnpm, yarn and bun work the same way. For Deno, use `deno add npm:@thewonderjoy/gaze-js`. It needs Node 20.19 or newer (22.12+ recommended) and has no dependencies of its own.

Open the [Gaze app](https://thewonderjoy.com/products/gaze) and send something:

```bash
node -e "import('@thewonderjoy/gaze-js').then(({ gaze }) => gaze('Hello from Node'))"
```

### dependencies or devDependencies?

| You use it in | Install with | Why |
|---|---|---|
| Server code that imports it: Express, Fastify, NestJS, Next.js, a CLI | `npm install` | Production installs often skip devDependencies (`npm ci --omit=dev`, most Docker images). A leftover `import` would then stop the app from starting. As a normal dependency it switches itself off in production instead. |
| Browser code built with Vite or webpack | `npm install` or `npm install -D` | The bundler copies it into your build, so either works. |
| Only a dev script, through `gaze-js run` or `node --import` | `npm install -D` | Your code never imports it. |

## Use

```js
import { gaze } from '@thewonderjoy/gaze-js';

gaze('order', order).blue().label('checkout');
gaze().table(rows, 'Rows');
gaze().exception(err);
await gaze().pause(); // waits until you press Continue in the app
```

`require('@thewonderjoy/gaze-js')` works too.

Jest needs no config. It loads a CommonJS copy of the package, so a test that runs your code sends its `gaze()` calls to the app. `@thewonderjoy/gaze-js/auto` installs nothing in test files.

`gaze()` copies the value when you call it, so changing the object afterwards doesn't change what you logged. If the app is closed, entries wait in a small queue and go out when it opens. Gaze never throws into your code.

Short scripts need nothing extra, because pending sends finish before Node exits. If you call `process.exit()`, call `await gaze.flush()` first. In edge handlers, use `ctx.waitUntil(gaze.flush())`.

## Node servers

Start your dev server through `gaze-js run`, and every incoming request shows up in the app as its own group. You don't change any code.

```json
"scripts": {
  "dev": "gaze-js run -- next dev"
}
```

The `gaze-js` command comes with the package, so install it first. When only this script uses it, `npm install -D @thewonderjoy/gaze-js` is enough. npm scripts find it by themselves. From a terminal, `npx gaze-js run -- node server.js` uses your installed copy and downloads nothing.

Put the real command after `--` (`next dev`, `node server.js`), not `npm run dev`. A `dev` script that runs `npm run dev` would keep calling itself.

`gaze-js run` loads the client into every Node process the command starts. Next.js and similar tools start worker processes, so they need it. For a server that runs as one process, preloading it with Node also works:

```bash
node --import @thewonderjoy/gaze-js/auto server.js
```

What you get:

- **Requests.** One group per incoming HTTP request in Express, Fastify, Hono, NestJS, Next.js or plain `node:http`. Your `gaze()` calls, console output, outgoing `fetch` calls, errors and queries go into it, and a summary row with the status and duration closes it. That includes an error thrown in a NestJS controller or a Fastify route, which the framework answers with a 500 itself.
- **SQL.** Queries from `pg`, `mysql2`, `mariadb`, `postgres` and `better-sqlite3`. Prisma 7, Drizzle, Kysely and Knex use these drivers, so their queries show up too. For Prisma that covers its Postgres, MySQL/MariaDB and SQLite adapters. When the same query runs more than three times in one request, the runs fold into one N+1 row that lists each of them. Queries that take 100 ms or longer are marked slow; set `GAZE_SLOW_QUERY_MS` to change that.
- **Less noise.** Console lines and network calls that your dependencies make outside a request, such as start-up banners and update checks, are left out.

In Next.js, route handlers, Server Components and the server render of Client Components each land in their request, and entries point at your own files.

Without `GAZE_CAPTURE` all five parts are on. To capture only some, list them: `GAZE_CAPTURE=errors,requests,queries`. Parts you leave out are off. The full list is `console,errors,network,requests,queries`.

Not covered: `node:http2` servers, `Bun.serve` and `Deno.serve`. Finding database drivers that another package brings along, as Prisma's adapters do, needs Node 22.15+, and so does `mariadb` in a CommonJS app. Queries made through an ORM often have no file and line. NestJS errors are picked up from Nest's own logger, so not with `logger: false` or a logger you set up yourself. Fastify errors are picked up from route handlers and `preHandler` hooks, not from other hooks such as `onRequest` or `onSend`.

## Browser apps

### Vite plugin

```js
// vite.config.js
import gaze from '@thewonderjoy/gaze-js/vite';

export default { plugins: [gaze({ project: 'shop' })] };
```

In `vite dev` the plugin:

- adds the client to your pages, Laravel Blade pages included,
- sends browser entries through Vite's own connection, so there's no CORS to set up and it works from a phone on your network,
- forwards Vite compile errors to the app,
- points browser entries and errors at your source files and lines, so "Open in editor" works for them.

In `vite build` it swaps the client for the no-op build, so production bundles send nothing.

| Option | Default | |
|---|---|---|
| `project` | the Vite root folder's name | The project name shown in the app. |
| `capture` | `false` | `true` forwards console output, errors and network calls from the browser. `{ network: true }` forwards only network calls: parts you leave out are off. Network capture is what [links browser calls to server requests](#link-browser-calls-to-server-requests). |
| `inject` | `true` | Adds the client to your pages and entry modules. |
| `entries` | | More entry modules to add the client to, relative to the Vite root. |
| `bridge` | `true` | Sends browser entries through Vite's connection. `false` makes the browser post to the app directly. |
| `viteErrors` | `true` | Forwards Vite compile errors to the app. |
| `callSites` | `false` | Rewrites `gaze()` calls so they carry the exact file, line and column. Needs Vite 8. |
| `noopInBuild` | `true` | Swaps the client for the no-op in `vite build`. |
| `apply` | `'serve'` | When the plugin runs. |
| `host`, `port`, `url`, `wire`, `enabled` | | As in [Settings](#settings). |

### Vue, React and Svelte

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

### Without a bundler

Copy `node_modules/@thewonderjoy/gaze-js/dist/gaze.global.js` to your public folder and load it on pages in development only. In Blade, wrap both tags in `@env('local') … @endenv`.

```html
<script src="/vendor/gaze/gaze.global.js" data-port="23517"></script>
<script>gaze('hello from a Blade page')</script>
```

## Link browser calls to server requests

Gaze can show which browser call started a server request. With network capture on, each `fetch` and XHR call from the page carries a W3C `traceparent` header. gaze-laravel, and Node servers started through `gaze-js run`, read it. The request keeps its own group with its queries, logs and exceptions, and its header in the app links back to the call: `from browser POST /api/cart`.

1. **Turn on network capture in the browser.** It's off by default.

   ```js
   // vite.config.js
   gaze({ capture: { network: true } }) // `capture: true` forwards console output and errors too
   ```

   Without the Vite plugin, `import '@thewonderjoy/gaze-js/auto'` or `await gaze.capture({ network: true })` does the same.
2. **Run the server with Gaze.** [gaze-laravel](https://packagist.org/packages/thewonderjoy/gaze-laravel) needs nothing more. Start a Node server through `gaze-js run` (see [Node servers](#node-servers)).
3. **If the API is on another origin, list it.** Calls to the page's own origin get the header without this. Another port counts as another origin.

   ```js
   import { gaze } from '@thewonderjoy/gaze-js';

   gaze.configure({ propagate: ['http://localhost:3000'] });
   ```

   The API must allow the `traceparent` header in CORS. Laravel's default CORS config allows any header on `api/*`. NestJS's `app.enableCors()` allows it unless you set `allowedHeaders`, so add `traceparent` there.

| Your setup | Steps |
|---|---|
| Laravel with React, Vue or Svelte through Vite, Inertia or Blade | 1 and 2. The pages and their API share one origin. |
| A Vite app that calls its API through `server.proxy` | 1 and 2. The browser sees one origin. |
| A Vite app on `localhost:5173` that calls an API on another port or domain, such as NestJS on `localhost:3000` | 1, 2 and 3. |

Laravel and React through Vite, for example:

```js
// vite.config.js
import laravel from 'laravel-vite-plugin';
import react from '@vitejs/plugin-react';
import gaze from '@thewonderjoy/gaze-js/vite';

export default {
  plugins: [
    laravel({ input: 'resources/js/app.jsx', refresh: true }),
    react(),
    gaze({ capture: { network: true } }),
  ],
};
```

Node servers add the header to their own calls to local and `*.test` hosts too, so one service calling another links as well. `fetch` does this on any supported Node; calls through `node:http`, as axios makes them, need Node 22.12 or newer.

## Production

In production you get a no-op instead of the client. Every call does nothing, `die()` doesn't exit, nothing is patched or sent, and `enable()` can't switch it back on.

- **Node, Bun and Deno.** It's off when `NODE_ENV=production` or `GAZE_ENABLED=false`. Set `GAZE_ENABLED=true` to use it in production for a while.
- **Bundled code.** Vite, webpack and Next.js production builds contain only the no-op, which is about 0.4 KB. They pick it through the package's `production` export condition. esbuild ignores that condition, but when it minifies it fills in `process.env.NODE_ENV`, so the client ends up in the bundle switched off. If your bundler does neither, alias `@thewonderjoy/gaze-js` to `@thewonderjoy/gaze-js/noop` in production builds.
- **Script tag.** `gaze.global.js` can't tell production from development, so add it to pages in development only.

## Methods

Each method returns the same object, so calls chain: `gaze(x).red().label('x')`.

**Send something**

| Method | What it shows |
|---|---|
| `gaze(...values)`, `send(...values)`, `raw(...values)` | One or more values in one entry. |
| `pass(value)` | Sends `value` and returns it: `return gaze().pass(total);` |
| `text(text)` | Plain text. |
| `html(html)` | Rendered HTML, in a sandbox where scripts don't run. |
| `markdown(markdown)` | Rendered Markdown. |
| `mermaid(source)` | A Mermaid diagram. |
| `json(...jsonStrings)` | JSON text, decoded and shown as a tree. |
| `toJson(...values)` | Values shown as a JSON tree. |
| `xml(xml)` | XML. |
| `table(data, label?)` | An object, `Map` or array as a key/value table, or an array of objects as rows and columns. |
| `image(src)` | An image from a URL, a path or base64 data. |
| `date(date = now)` | A date: a `Date`, a timestamp or a string. |
| `className(value)` | The class of a value. |
| `separator()` | A divider line. |
| `exception(err, meta?)` | An error in red, with its stack, `cause` chain and `AggregateError` members. |
| `entry(kind, body)` | An entry of any kind, with a JSON body. |

**Update an entry**

| Method | What it does |
|---|---|
| `gaze.at(id)` | Targets a fixed entry id: `gaze.at('cart').send(cart)` updates the same entry each time. |
| `append(...values)` | Adds to the entry instead of replacing what it shows. |
| `gaze().id` | The entry's id. |

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
| `if(condition, (g) => ...)` | Runs the callback when the condition is true. |
| `once(...values)` | Sends only the first time this line runs. |
| `limit(n)` | Sends at most `n` times from this line. |
| `count(name?)` | Counts how often this line, or this name, runs, in one entry. |
| `counterValue(name)`, `clearCounters()` | Reads or resets the counters. |
| `rateLimiter().max(n).perSecond(n)` | Caps how much is sent in total, or per second. `.clear()` removes the caps. |
| `enable()`, `disable()`, `enabled()`, `disabled()` | Turns sending on or off, or checks it. |

**Debug**

| Method | What it does |
|---|---|
| `await pause()` | Waits until you press Continue in the app. Stop throws a `StopExecutionRequested` error, as in gaze-php. Express 5 and NestJS answer that request with a 500 and keep running. Express 4 and plain `node:http` don't catch errors from async handlers, so there the process exits. Resolves at once if the app is closed. |
| `measure(name = 'default')` | A stopwatch. The first call starts it, later calls show the total and lap time. |
| `measure(fn)` | Times a function, sync or async. |
| `stopTime(name?)` | Forgets one stopwatch, or all of them. |
| `trace(limit = 25)`, `backtrace(...)` | The stack trace from this line. |
| `caller()` | The function that called the current one. |
| `gaze.group(label, fn)` | Groups the entries made inside `fn` and returns its result. |
| `gaze.watch(() => value, { interval: 500 })` | Sends the value again whenever it changes. Returns a stop function. |
| `await die(code = 1)` | Sends everything, then exits in Node, Bun and Deno, or rejects in browsers. Does nothing while Gaze is off. |

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
| `project(name)` | The project name for this entry and later ones. |

**Setup**

| Method | What it does |
|---|---|
| `await gaze.capture({ console, errors, network })` | Forwards console output, errors and `fetch` calls. In Node also `requests` and `queries` (see [Node servers](#node-servers)). With no options it installs every part; with options, only the ones set to `true`. Resolves to an uninstall function. |
| `await gaze.flush()` | Sends everything queued. |
| `gaze.configure(options)` | Changes settings (below). |
| `gaze.macro(name, fn)` | Adds your own method: `gaze.macro('double', function (n) { return this.send(n * 2) })`. |

## Imports

| Import | What you get |
|---|---|
| `@thewonderjoy/gaze-js` | `gaze`, also exported as `ray` and `dump`. Picks the Node, browser or edge build by itself. |
| `@thewonderjoy/gaze-js/auto` | Import once to forward console output, errors and network calls. In Node also request traces and SQL. |
| `@thewonderjoy/gaze-js/vite` | The Vite plugin. |
| `@thewonderjoy/gaze-js/noop` | The same API, doing nothing. For production builds. |
| `@thewonderjoy/gaze-js/vue` | `RayPlugin`, `useRay()` |
| `@thewonderjoy/gaze-js/react` | `useRay()`, `<RayBoundary>`, `rayRootOptions()` |
| `@thewonderjoy/gaze-js/svelte` | `rayInspect`, `rayInspector()`, `rayBoundary()` |
| `@thewonderjoy/gaze-js/global` | A build for a script tag. It sets `window.gaze`, `window.ray` and `window.dump`, skipping any name the page already uses. |

## Settings

`gaze.configure(options)`:

| Option | Default | |
|---|---|---|
| `host`, `port` | `localhost`, `23517` | Node also reads `GAZE_HOST` and `GAZE_PORT`. |
| `enabled` | `true` | `false` pauses sending until `gaze.enable()`. No setting turns on the production no-op. |
| `project` | | A name, or `{ name, root }`. |
| `url` | | Sends to a relay instead, for example `https://app.test/_gaze`. |
| `propagate` | | More origins whose requests get a `traceparent` header, so the app can link a server request to the call that made it. Same-origin calls get it anyway, and in Node so do calls to local hosts. The server must allow the header in CORS. |
| `wire` | `native` | The message format. See [Ray compatibility](#ray-compatibility). |

## Ray compatibility

Gaze works with Spatie Ray's clients and message format, and this package keeps Ray's API:

- `ray` and `dump` are the same function as `gaze`, and the method names match node-ray. Code written for node-ray works once you change the import.
- In Node, `RAY_HOST` and `RAY_PORT` are read when `GAZE_HOST` and `GAZE_PORT` aren't set.
- `wire: 'ray'` sends in Ray's format, so this client also works with the Ray app and Buggregator. `wire: 'auto'` asks the app which format it speaks.
- The Gaze app accepts Ray's format too, so node-ray and the other Ray clients can send to it unchanged.

Not included from node-ray: `file()`, `event()`, `htmlMarkup()`, `chain()`, `ban()`, `charles()`, `error()` (use `exception()`), `sendCustom()` (use `entry()`) and `interceptor()` (use `gaze.capture({ console: true })`).

## License

MIT
