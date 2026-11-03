// Errors a Node framework catches and prints itself: NestJS answers 500 for an error thrown in a
// controller and writes it straight to process.stderr. Inside a trace that write becomes an exception
// entry, read back from the printed text.
import { Console } from 'node:console';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StopExecutionRequested } from '../src/core/ray.js';
import { parseStack } from '../src/core/stack.js';
import type { WireEntry } from '../src/core/types.js';
import { captureRequests } from '../src/node/requests.js';
import { captureStderr, parseErrorText } from '../src/node/stderr.js';
import { ctx, mapFrame } from '../src/platform/node.js';
import { expectValidBatch, lineOf, makeRay, settle } from './helpers.js';

const here = fileURLToPath(import.meta.url);
const slash = (p: string) => p.replace(/\\/g, '/');
const body = (e: WireEntry) => e.body as { class: string; message: string; code?: string; frames: { file: string; line: number }[]; previous?: unknown };

/** What Nest 12's ConsoleLogger writes for `logger.error(err)`: one chunk, its prefix, then util.inspect(err) in colour. */
const nest = (err: unknown) =>
  `\x1b[31m[Nest] 4242  - \x1b[39m03/11/2026, 4:22:50 pm \x1b[31m  ERROR\x1b[39m \x1b[38;5;3m[ExceptionsHandler] \x1b[39m${inspect(err, { colors: true })}\n`;

const undo: (() => void)[] = [];
let written: string[] = [];
let write: typeof process.stderr.write;
let recorder: typeof process.stderr.write;
// stderr goes to a recorder here, so the test output stays quiet and the pass-through can be checked.
beforeEach(() => {
  write = process.stderr.write;
  written = [];
  recorder = ((chunk: unknown) => (written.push(String(chunk)), true)) as typeof write;
  process.stderr.write = recorder;
});
afterEach(() => {
  undo.splice(0).forEach((f) => f());
  process.stderr.write = write;
});

describe('errors a framework prints to stderr', () => {
  it('reads name, code, message, frames and causes back from the printed text', () => {
    const err = new TypeError('first line\nsecond: line', { cause: new RangeError('the cause') });
    const e = parseErrorText(nest(err))!;
    expect(e).toMatchObject({ name: 'TypeError', message: 'first line\nsecond: line' });
    expect(parseStack(e.stack)).toEqual(parseStack(err.stack));
    expect(e.cause).toMatchObject({ name: 'RangeError', message: 'the cause' });
    expect(parseStack((e.cause as Error).stack)).toEqual(parseStack((err.cause as Error).stack));

    expect(parseErrorText('Error [ERR_HTTP_HEADERS_SENT]: Cannot set headers\n    at a (/app/x.js:1:2)\n')).toMatchObject({
      name: 'Error',
      code: 'ERR_HTTP_HEADERS_SENT',
      message: 'Cannot set headers',
    });
    expect(parseErrorText('[Nest] 1  - ERROR [Ctx] Error\n    at a (/app/x.js:1:2)\n')).toMatchObject({ name: 'Error', message: '' });
    expect(parseErrorText('Error: no frames\n')).toBeUndefined();
    expect(parseErrorText('    at a (/app/x.js:1:2)\n')).toBeUndefined();
    expect(parseErrorText('nothing here\n    at a (/app/x.js:1:2)\n')).toBeUndefined();
  });

  it("sends the error Nest prints for a request as an exception in that request's trace", async () => {
    const { ray, entries, batches } = makeRay({ ctx, mapFrame });
    undo.push(captureRequests(ray, ctx), captureStderr(ray));
    const s = http.createServer(async (req, res) => {
      try {
        await settle(1);
        throw new TypeError('later from the controller', { cause: new Error('the cause') }); // @throw
      } catch (e) {
        // As Nest's BaseExceptionFilter does: answer first, then log.
        res.statusCode = 500;
        res.end('{"statusCode":500}');
        process.stderr.write(nest(e));
      }
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as { port: number }).port;
    expect((await fetch(`http://127.0.0.1:${port}/oops`)).status).toBe(500);
    s.close();
    await settle(20);
    await ray.flush();
    for (const b of batches()) expectValidBatch(b);

    const sum = entries().find((e) => e.kind == 'request')!;
    const ex = entries().filter((e) => e.kind == 'exception');
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ color: 'red', trace: { id: sum.trace!.id } });
    expect(body(ex[0]!)).toMatchObject({ class: 'TypeError', message: 'later from the controller', previous: { class: 'Error', message: 'the cause' } });
    const at = [slash(here), lineOf(here, '@throw')];
    expect([slash(ex[0]!.origin!.file!), ex[0]!.origin!.line]).toEqual(at);
    expect([slash(body(ex[0]!).frames[0]!.file), body(ex[0]!).frames[0]!.line]).toEqual(at);
    expect(written.join(''), 'still printed').toContain('later from the controller');
  });

  it('leaves alone console output, Stop, other text and writes outside a trace', async () => {
    const { ray, entries } = makeRay({ ctx, mapFrame });
    undo.push(captureStderr(ray));
    // A Console of its own on process.stderr: Vitest's global console writes elsewhere.
    const con = new Console({ stdout: process.stderr, stderr: process.stderr });
    process.stderr.write(nest(new Error('outside a trace')));
    await ray.group('job', async () => {
      con.error(new Error('through console'));
      process.stderr.write(nest(new StopExecutionRequested()));
      process.stderr.write(Buffer.from(nest(new Error('a buffer'))));
      process.stderr.write('a plain line\n');
      process.stderr.write(new Error('a bare stack').stack + '\n');
    });
    await ray.flush();
    const ex = entries().filter((e) => e.kind == 'exception');
    expect(ex.map((e) => body(e).message)).toEqual(['a bare stack']);
    expect(ex[0]!.trace?.name).toBe('job');
    expect(written.join('')).toContain('through console');

    undo.pop()!();
    expect(process.stderr.write, 'undo puts the original back').toBe(recorder);
    process.stderr.write('after undo\n');
    expect(written.at(-1)).toBe('after undo\n');
  });
});
