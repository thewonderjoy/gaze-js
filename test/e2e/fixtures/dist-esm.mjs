// Run as a child process against the built package. No explicit flush: the pending send keeps the
// process alive until the batch is delivered.
import { ray } from '../../../dist/node.js';

ray('from dist esm', { n: 1 }).green(); // @dist-esm
