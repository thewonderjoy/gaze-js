// require(esm) through the package's own "exports" (self-reference): resolves the `default`/`node`
// condition to dist/node.js. Port comes from RAY_PORT (GAZE_PORT unset) to exercise the fallback.
const { ray, gaze, dump } = require('@thewonderjoy/gaze-js');

if (gaze !== ray || dump !== ray) throw new Error('aliases');
ray('from require(esm)').label('cjs'); // @require-cjs
