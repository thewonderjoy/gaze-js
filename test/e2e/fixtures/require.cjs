// require() through the package's own "exports" (self-reference). Node matches `module-sync` and loads
// dist/node.js through require(esm); run without require(esm), as Jest's loader is, it gets
// dist/cjs/node.cjs. Port comes from RAY_PORT (GAZE_PORT unset) to exercise the fallback.
const { ray, gaze, dump } = require('@thewonderjoy/gaze-js');

const at = require.resolve('@thewonderjoy/gaze-js').replace(/\\/g, '/').replace(/^.*\/dist\//, '');
if (gaze !== ray || dump !== ray) throw new Error('aliases');
ray(`from require: ${at}`).label('cjs'); // @require-cjs
