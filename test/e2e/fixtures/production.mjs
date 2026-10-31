// NODE_ENV=production: the package resolves to the real entry (plain Node applies no `production`
// condition), which exports the no-op. Prints what ran, as JSON.
import dc from 'node:diagnostics_channel';
import { ray } from '@thewonderjoy/gaze-js';
import '@thewonderjoy/gaze-js/auto';

const log = console.log;
ray('must not arrive (NODE_ENV=production)');
ray.enable();
ray.configure({ enabled: true });
ray('must not arrive after enable()');
await ray.capture();
await ray().die(); // must not exit
await ray.flush();
log(
  JSON.stringify({
    resolved: import.meta.resolve('@thewonderjoy/gaze-js').replace(/^.*\/dist\//, ''),
    enabled: ray.enabled(),
    group: ray.group('g', () => 42),
    console: console.log === log,
    channels: ['http.server.request.start', 'http.client.request.created', 'tracing:mysql2:query:start'].filter((n) => dc.channel(n).hasSubscribers),
    store: globalThis[Symbol.for('gaze.ctx')] !== undefined,
    exitHooks: process.listenerCount('beforeExit'),
  }),
);
