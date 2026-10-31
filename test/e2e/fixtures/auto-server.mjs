// Started with --import dist/auto-node.js: one request to its own server, then exit.
import http from 'node:http';
import { ray } from '../../../dist/node.js';

console.log('auto: before any request'); // @auto-outside
const s = http.createServer((req, res) => {
  console.log('auto: in request'); // @auto-console
  ray('auto: ray in request');
  res.end('ok');
});
await new Promise((r) => s.listen(0, '127.0.0.1', r));
await fetch(`http://127.0.0.1:${s.address().port}/orders/7`).then((r) => r.text());
s.close();
await ray.flush();
