// Synchronous call-site capture. V8/JSC: Error.captureStackTrace(holder, boundary) drops every frame
// above the public function the user called. Everywhere else (and for frames between the boundary
// and the user, e.g. adapters), leading frames from our own files are dropped: our own file is learnt
// from a stack captured at module load, and every file under the same `dist/` (or `src/`) directory
// counts as ours. No substring matching on names like `-ray` (node-ray defect 03 §2.7 #9).
import type { Frame } from './types.js';

const V8 = /^\s*at (?:(.+?) \()?(?:async )?(.+?):(\d+):(\d+)\)?$/;
const GECKO = /^\s*(.*?)@(.+?):(\d+):(\d+)$/;
const E = Error as ErrorConstructor & {
  stackTraceLimit?: number;
  captureStackTrace?: (target: object, boundary?: Function) => void;
};

const clean = (f: string): string => f.replace(/[?#].*$/, '');

/** Parse a V8 (`at fn (file:1:2)`) or SpiderMonkey/JSC (`fn@file:1:2`) stack. */
export function parseStack(stack: unknown, max = 50): Frame[] {
  const out: Frame[] = [];
  if (typeof stack != 'string') return out;
  for (const line of stack.split('\n')) {
    const m = V8.exec(line) || GECKO.exec(line);
    if (!m) continue;
    const file = clean(m[2]!);
    const f: Frame = { file, line: +m[3]!, col: +m[4]! };
    let name = (m[1] || '').replace(/^(async|new) /, '').replace(/ \[as .*\]$/, '');
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
      const cls = name.slice(0, dot);
      if (cls != 'Object' && cls != 'Module' && cls != '<anonymous>') f.class = cls;
      name = name.slice(dot + 1);
    }
    if (name && name != '<anonymous>') f.function = name;
    if (/node_modules[\\/]|^node:|^internal[\\/]/.test(file)) f.vendor = true;
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

const here = parseStack(new Error().stack)[0]?.file ?? '';
const dir = here.replace(/[^\\/]*$/, '');
/** Prefix of our own files: `…/dist/`, `…/src/` (tests), `…/.vite/deps/`; empty for a lone IIFE file. */
const own = /[\\/](dist|deps|src)[\\/]$/.test(dir) ? dir : /[\\/]src[\\/]core[\\/]$/.test(dir) ? dir.slice(0, -5) : '';

export const isOwn = (file: string): boolean => file == here || (!!own && file.startsWith(own));

/**
 * Frames of the caller of `boundary`, our own frames removed. `limit` bounds the result; the engine
 * captures a few more so that our own frames do not eat the budget.
 */
export function callerFrames(boundary?: Function, limit = 1): Frame[] {
  const h: { stack?: string } = {};
  const old = E.stackTraceLimit;
  const set = (n?: number) => {
    try {
      if (typeof old == 'number') E.stackTraceLimit = n as number;
    } catch {}
  };
  set(limit + 10);
  if (E.captureStackTrace && boundary) E.captureStackTrace(h, boundary);
  // The boundary was not on the stack (V8 then returns nothing): fall back to the full stack.
  const bounded = !!h.stack && /:\d+:\d+/.test(h.stack);
  if (!bounded) h.stack = new Error().stack;
  set(old);
  const frames = parseStack(h.stack, limit + 10);
  let i = 0;
  // Bundled into one file with other code (a Next.js or webpack chunk: no dist/ or src/ folder of our
  // own), that file is the caller's too, so after a boundary capture nothing is skipped by file.
  if (own || !bounded) while (i < frames.length && isOwn(frames[i]!.file)) i++;
  return frames.slice(i, i + limit);
}
