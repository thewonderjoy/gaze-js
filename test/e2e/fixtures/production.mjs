import { ray } from '../../../dist/node.js';

ray('must not arrive (NODE_ENV=production)');
await ray.flush();
