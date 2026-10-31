// Native entry -> Spatie Ray v1 envelope `{uuid, payloads[], meta}` (research note 01 §3-§4).
// Values go out as plain JSON or text, never as client-built dump HTML (node-ray defect 03 §2.7 #8).
// Text is HTML-escaped because Ray renders `custom` content as HTML.
import { plain } from './serialize.js';
import type { Frame, Value, WireEntry } from './types.js';

interface Payload {
  type: string;
  content: unknown;
  origin: Record<string, unknown>;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#039' }[c]};`);
const json = (v: Value): string => JSON.stringify(plain(v)) ?? 'null';
const rayFrame = (f: Frame) => ({
  file_name: f.file,
  line_number: f.line,
  class: f.class ?? null,
  method: f.function ?? '',
  vendor_frame: !!f.vendor,
});

/** Table cell: scalars raw, text escaped, structures as escaped JSON. */
const cell = (v: Value): unknown =>
  v.k == 'str' ? esc(v.v) : v.k == 'int' || v.k == 'float' || v.k == 'bool' ? v.v : v.k == 'null' || v.k == 'undef' ? null : esc(json(v));

/** Content payloads for one entry body. */
function content(kind: string, b: Record<string, any>): [string, unknown][] {
  switch (kind) {
    case 'log': {
      const out: [string, unknown][] = [];
      let run: unknown[] | undefined;
      for (const v of b.values as Value[]) {
        if (v.k == 'str' || v.k == 'int' || v.k == 'float') {
          if (!run) out.push(['log', { values: (run = []) }]);
          run.push(plain(v));
          continue;
        }
        run = undefined;
        if (v.k == 'bool') out.push(['custom', { content: v.v, label: 'Boolean' }]);
        else if (v.k == 'null' || v.k == 'undef') out.push(['custom', { content: null, label: 'Null' }]);
        else out.push(['json_string', { value: json(v) }]);
      }
      return out;
    }
    case 'text':
      return [['custom', { content: esc(b.text).replace(/ /g, '&nbsp;').replace(/\r?\n/g, '<br>'), label: 'Text' }]];
    case 'html':
      return [['custom', { content: b.html, label: 'HTML' }]];
    case 'markdown':
      return [['ai_custom_markdown', { markdown: b.markdown }]];
    case 'mermaid':
      return [['ai_custom_mermaid', { mermaid: b.source }]];
    case 'json':
      return [['json_string', { value: json(b.value) }]];
    case 'image':
      return [['custom', { content: `<img src="${esc(b.src)}" alt="" />`, label: 'Image' }]];
    case 'date':
      return [['carbon', b]];
    case 'separator':
      return [['separator', {}]];
    case 'lock':
      return [['create_lock', { name: b.name }]];
    case 'trace':
      return [['trace', { frames: b.frames.map(rayFrame) }]];
    case 'exception':
      return [
        [
          'exception',
          {
            class: b.class,
            message: b.message,
            frames: b.frames.map((f: Frame) => ({ ...rayFrame(f), snippet: [] })),
            meta: b.context ? plain(b.context) : {},
          },
        ],
      ];
    case 'measure':
      return [
        [
          'measure',
          {
            name: b.name,
            is_new_timer: !!b.is_new,
            total_time: b.total_ms ?? 0,
            max_memory_usage_during_total_time: b.mem_peak ?? 0,
            time_since_last_call: b.since_last_ms ?? 0,
            max_memory_usage_since_last_call: b.mem_delta ?? 0,
          },
        ],
      ];
    case 'table': {
      const values: Record<string, unknown> = {};
      if (b.entries) for (const [k, v] of b.entries as [string, Value][]) values[k] = cell(v);
      else
        (b.rows as Value[][]).forEach((row, i) => {
          const rec: Record<string, unknown> = {};
          row.forEach((v, c) => (rec[b.columns?.[c] ?? c] = plain(v)));
          values[i] = esc(JSON.stringify(rec));
        });
      return [['table', { values, label: b.label || 'Table' }]];
    }
    case 'cmd': {
      const c = b.cmd as string;
      return [
        c == 'clear'
          ? ['clear_all', {}]
          : c == 'notify'
            ? ['notify', { value: b.text }]
            : c == 'new_screen'
              ? [c, { name: b.name ?? '' }]
              : c == 'screen_color'
                ? [c, { color: b.color }]
                : [c, {}],
      ];
    }
  }
  return [['custom', { content: `<pre>${esc(JSON.stringify(b, null, 2))}</pre>`, label: kind }]];
}

export interface RayMeta {
  project_name: string;
  client_name: string;
  client_version: string;
}

/** One Ray envelope (JSON text) for one native entry. */
export function rayEnvelope(e: WireEntry, meta: RayMeta, hostname: string): string {
  const o = e.origin;
  const origin: Record<string, unknown> = { file: o?.file ?? '', line_number: o?.line ?? 0, hostname };
  if (o?.function) origin.function_name = o.function;
  const payloads: Payload[] = [];
  const add = (type: string, c: unknown) => payloads.push({ type, content: c, origin });
  if (e.op == 'remove') add('remove', {});
  else if (e.body && e.kind) for (const [t, c] of content(e.kind, e.body)) add(t, c);
  if (e.color) add('color', { color: e.color });
  if (e.size && e.size != 'md') add('size', { size: e.size });
  if (e.label != null) add('label', { label: e.label });
  if (e.hidden) add('hide', {});
  if (e.expand) add('expand', { keys: e.expand.paths ?? [], level: e.expand.level ?? null });
  return JSON.stringify({ uuid: e.id, payloads, meta });
}
