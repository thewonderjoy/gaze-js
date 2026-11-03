// production.mjs for require() without require(esm), as in Jest: the CommonJS copy also exports the
// no-op. Prints what ran, as JSON.
const dc = require('node:diagnostics_channel');
const { ray } = require('@thewonderjoy/gaze-js');
require('@thewonderjoy/gaze-js/auto');

(async () => {
  const log = console.log;
  ray('must not arrive (CommonJS copy)');
  ray.enable();
  ray.configure({ enabled: true });
  ray('must not arrive after enable() (CommonJS copy)');
  await ray.capture();
  await ray().die(); // must not exit
  await ray.flush();
  log(
    JSON.stringify({
      resolved: require.resolve('@thewonderjoy/gaze-js').replace(/\\/g, '/').replace(/^.*\/dist\//, ''),
      enabled: ray.enabled(),
      group: ray.group('g', () => 42),
      console: console.log === log,
      channels: ['http.server.request.start', 'http.client.request.created', 'tracing:mysql2:query:start'].filter((n) => dc.channel(n).hasSubscribers),
      store: globalThis[Symbol.for('gaze.ctx')] !== undefined,
      exitHooks: process.listenerCount('beforeExit'),
    }),
  );
})();
