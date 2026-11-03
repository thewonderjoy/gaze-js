// Errors a framework catches and prints itself. NestJS's ExceptionsHandler answers 500 for an error
// thrown in a controller, and its ConsoleLogger writes the error (util.inspect, coloured, after a log
// prefix) straight to process.stderr, so neither the console patch nor the uncaught-error handlers see
// it. Inside a trace, a stderr write that holds a V8 stack trace becomes an exception entry there: the
// name, code, message, frames and [cause] chain are read back from the text, and the frames are
// source-mapped like any other exception's. Left alone: writes made through console (already a console
// entry) or by this package, pause()'s StopExecutionRequested (it only ends the request) and Buffers.
// Not covered: a Nest app with `logger: false` or a logger of its own, which never writes here.
import { errRay } from '../capture.js';
import type { RayFn } from '../core/ray.js';
import { isOwn, parseStack } from '../core/stack.js';

const G = globalThis as Record<string, any>;
const E = Error as ErrorConstructor & { stackTraceLimit?: number; captureStackTrace?: (t: object, f?: Function) => void };
const ANSI = /\x1b\[[0-9;]*m/g;
const FRAME = /^\s+at \S/;
/** util.inspect folds the frames an error shares with its cause into this line. */
const FOLDED = /^\s+\.\.\. (\d+) lines? matching cause stack trace \.\.\.$/;
/** `Name: message`, `Name [CODE]: message` or a bare `Name`, after any log prefix. */
const HEAD = /(?:^|[\s\]])([A-Z][\w$]*)(?: \[([\w-]+)\])?(?:: |:?$)/;
const CAUSE = /^\s*\[cause\]: /;

/** The error that printed text (err.stack or util.inspect(err), with any prefix and colours) shows. */
export function parseErrorText(text: string, depth = 0): Error | undefined {
  const lines = text.replace(ANSI, '').split(/\r?\n/);
  const at = lines.findIndex((l) => FRAME.test(l));
  let head = 0;
  let m: RegExpExecArray | null = null;
  while (head < at && !(m = HEAD.exec(lines[head]!))) head++;
  if (!m) return undefined;
  const message = [lines[head]!.slice(m.index + m[0].length), ...lines.slice(head + 1, at)].join('\n');
  const frames: string[] = [];
  const folds: [number, number][] = [];
  let i = at;
  for (; i < lines.length; i++) {
    const f = FOLDED.exec(lines[i]!);
    if (f) folds.push([frames.length, +f[1]!]);
    else if (FRAME.test(lines[i]!)) frames.push(lines[i]!.trim().replace(/ \{$/, ''));
    else break;
  }
  while (i < lines.length && !CAUSE.test(lines[i]!)) i++;
  const cause = i < lines.length && depth < 5 ? parseErrorText(lines.slice(i).join('\n').replace(CAUSE, ''), depth + 1) : undefined;
  // The folded frames follow, in the cause's stack, the frame printed just before the fold.
  const theirs = cause ? cause.stack!.split('\n').filter((l) => FRAME.test(l)).map((l) => l.trim()) : [];
  for (const [k, n] of folds.reverse()) {
    const j = theirs.indexOf(frames[k - 1]!);
    if (j >= 0) frames.splice(k, 0, ...theirs.slice(j + 1, j + 1 + n));
  }
  const e = new Error(message, cause && { cause }) as Error & { code?: string };
  e.name = m[1]!;
  if (m[2]) e.code = m[2];
  e.stack = [m[1] + (message ? ': ' + message : ''), ...frames.map((f) => '    ' + f)].join('\n');
  return e;
}

/** File of the function that called `fn`. */
function callerFile(fn: Function): string {
  const h: { stack?: string } = {};
  const old = E.stackTraceLimit;
  try {
    E.stackTraceLimit = 1;
    E.captureStackTrace?.(h, fn);
  } finally {
    E.stackTraceLimit = old;
  }
  return parseStack(h.stack)[0]?.file ?? '';
}

export function captureStderr(ray: RayFn): () => void {
  const S = G.process?.stderr;
  const c = ray.$client;
  if (typeof S?.write != 'function' || !c.p.ctx) return () => {};
  const write = S.write;
  let busy = false;
  const w = function (this: unknown, chunk: unknown) {
    if (!busy && typeof chunk == 'string' && /\n(?:\x1b\[[0-9;]*m)?\s+at /.test(chunk) && c.trace) {
      busy = true;
      try {
        const by = callerFile(w);
        if (!by.startsWith('node:internal/console/') && !isOwn(by)) {
          const e = parseErrorText(chunk);
          if (e && e.name != 'StopExecutionRequested') errRay(ray, e).exception(e);
        }
      } catch {
      } finally {
        busy = false;
      }
    }
    return write.apply(this, arguments);
  };
  S.write = w;
  return () => {
    if (S.write === w) S.write = write;
  };
}
