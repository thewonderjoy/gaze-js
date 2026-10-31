// Synchronous, bounded JS value -> RFC-0001 §5 Value tree. Runs at call time, so later mutation does
// not change what was logged. Never invokes user getters (accessors are listed as `getter` props),
// never calls toJSON/toString/valueOf on user objects. Repeated or cyclic objects become `ref` nodes.
import type { Limits, Prop, Value } from './types.js';

export const LIMITS: Limits = { depth: 8, items: 200, nodes: 5000, string: 16384 };

type Container = Extract<Value, { k: 'list' | 'map' | 'obj' }>;
const G = globalThis as Record<string, any>;
const desc = Object.getOwnPropertyDescriptor;
const protoOf = Object.getPrototypeOf;
const OBJ = Object.prototype;

export function str(s: string, max: number): Value {
  if (s.length <= max) return { k: 'str', v: s };
  // Do not split a surrogate pair.
  const end = (s.charCodeAt(max - 1) & 0xfc00) == 0xd800 ? max - 1 : max;
  return { k: 'str', v: s.slice(0, end), cut: s.length - end, len: s.length };
}

export function num(n: number): Value {
  if (n != n) return { k: 'float', v: 'NaN' };
  if (n == Infinity) return { k: 'float', v: 'INF' };
  if (n == -Infinity) return { k: 'float', v: '-INF' };
  if (Object.is(n, -0)) return { k: 'float', v: '-0' };
  return { k: Number.isSafeInteger(n) ? 'int' : 'float', v: n } as Value;
}

/** Constructor name from the prototype, without invoking accessors. */
export function className(o: object): string {
  const p = protoOf(o);
  if (p === null) return 'Object';
  const c = desc(p, 'constructor')?.value;
  return (typeof c == 'function' && desc(c, 'name')?.value) || 'Object';
}

const fnValue = (f: Function): Value => {
  const tag = desc(f, Symbol.toStringTag)?.value ?? desc(protoOf(f) ?? {}, Symbol.toStringTag)?.value ?? '';
  const v: Value = { k: 'fn', name: desc(f, 'name')?.value || '(anonymous)' };
  if (/^Async/.test(tag)) v.async = true;
  if (/Generator/.test(tag)) v.gen = true;
  return v;
};

const is = (o: object, name: string): boolean => typeof G[name] == 'function' && o instanceof G[name];

/**
 * Serialize one root value. `redact` masks object/map keys (hello.redact patterns).
 */
export function serialize(root: unknown, L: Limits = LIMITS, redact?: RegExp): Value {
  let nodes = 0;
  let ids = 0;
  const seen = new Map<object, Value>();

  const collapsed = (o: object, count: number): Value =>
    Array.isArray(o) || is(o, 'Set')
      ? { k: 'list', cls: Array.isArray(o) ? undefined : 'Set', count, items: [], cut: count }
      : is(o, 'Map')
        ? { k: 'map', cls: 'Map', count, entries: [], cut: count }
        : { k: 'obj', cls: className(o), props: [], cut: count };

  // A throwing Proxy trap or exotic host object must never reach user code.
  const walk = (v: unknown, d: number): Value => {
    try {
      return node(v, d);
    } catch {
      return { k: 'const', v: '[Unserializable]' };
    }
  };

  const node = (v: unknown, d: number): Value => {
    nodes++;
    switch (typeof v) {
      case 'string':
        return str(v, L.string);
      case 'number':
        return num(v);
      case 'boolean':
        return { k: 'bool', v };
      case 'undefined':
        return { k: 'undef' };
      case 'bigint':
        return { k: 'int', v: String(v) };
      case 'symbol':
        return { k: 'const', v: v.toString() };
      case 'function':
        return fnValue(v);
    }
    if (v === null) return { k: 'null' };
    const o = v as object;
    const prev = seen.get(o);
    if (prev) {
      if (prev.k == 'list' || prev.k == 'map' || prev.k == 'obj') {
        const c = prev as Container;
        return { k: 'ref', to: (c.id ??= ++ids), cls: c.cls };
      }
      return { k: 'const', v: '[Circular]' };
    }
    if (is(o, 'Date')) {
      const t = Date.prototype.getTime.call(o);
      return { k: 'date', iso: t == t ? Date.prototype.toISOString.call(o) : 'Invalid Date' };
    }
    if (is(o, 'RegExp')) return { k: 'const', v: RegExp.prototype.toString.call(o) };
    if (is(o, 'URL')) return { k: 'const', v: URL.prototype.toString.call(o) };
    if (is(o, 'Promise') || is(o, 'WeakMap') || is(o, 'WeakSet') || is(o, 'WeakRef'))
      return { k: 'const', v: className(o) };
    if (is(o, 'Node')) return dom(o as Node, L.string);
    if (o instanceof Error) {
      const e = o as Error & { cause?: unknown };
      const n: Value = { k: 'err', name: String(e.name), message: String(e.message) };
      seen.set(o, n);
      if (typeof e.stack == 'string') n.stack = e.stack.slice(0, L.string);
      if ('cause' in e && d < L.depth) n.cause = walk(e.cause, d + 1);
      return n;
    }

    if (ArrayBuffer.isView(o)) {
      if (is(o, 'DataView')) return { k: 'const', v: `DataView(${(o as DataView).byteLength})` };
      const t = o as unknown as ArrayLike<number | bigint>;
      return list(o, className(o), t.length, d, (i) => t[i]);
    }
    if (is(o, 'ArrayBuffer')) {
      const u = new Uint8Array(o as ArrayBuffer);
      return list(o, 'ArrayBuffer', u.length, d, (i) => u[i]);
    }
    if (Array.isArray(o)) {
      const cls = protoOf(o) === Array.prototype ? undefined : className(o);
      return list(o, cls, o.length, d, (i) => o[i]);
    }
    if (d >= L.depth || nodes >= L.nodes) {
      const size = is(o, 'Map') || is(o, 'Set') ? (o as Set<unknown>).size : Object.keys(o).length;
      return collapsed(o, size);
    }
    if (is(o, 'Set')) {
      const it = Set.prototype.values.call(o);
      return list(o, 'Set', (o as Set<unknown>).size, d, () => it.next().value);
    }
    if (is(o, 'Map')) {
      const m = o as Map<unknown, unknown>;
      const node: Value = { k: 'map', cls: 'Map', count: m.size, entries: [] };
      seen.set(o, node);
      const it = Map.prototype.entries.call(m);
      for (let i = 0; i < m.size; i++) {
        if (i >= L.items || nodes >= L.nodes) {
          node.cut = m.size - i;
          break;
        }
        const [k, val] = it.next().value as [unknown, unknown];
        const key = typeof k == 'string' || (typeof k == 'number' && Number.isSafeInteger(k)) ? k : walk(k, d + 1);
        node.entries.push([key, redact && typeof k == 'string' && redact.test(k) ? REDACTED : walk(val, d + 1)]);
      }
      return node;
    }

    const node: Value = { k: 'obj', cls: className(o), props: [] };
    seen.set(o, node);
    const keys = Reflect.ownKeys(o);
    const props = node.props;
    let i = 0;
    for (const key of keys) {
      const p = desc(o, key);
      if (!p || !p.enumerable) continue;
      if (i++ >= L.items || nodes >= L.nodes) {
        node.cut = (node.cut || 0) + 1;
        continue;
      }
      const n = typeof key == 'symbol' ? key.toString() : key;
      props.push(
        'value' in p
          ? { n, vis: 'pub', val: redact && redact.test(n) ? REDACTED : walk(p.value, d + 1) }
          : accessor(n, p),
      );
    }
    // Class instances: list prototype accessors (getters are shown, never invoked).
    for (let p = protoOf(o); p && p !== OBJ && props.length < L.items; p = protoOf(p)) {
      for (const key of Object.getOwnPropertyNames(p)) {
        const pd = desc(p, key)!;
        if (pd.get && key != '__proto__' && !props.some((x) => x.n == key)) props.push(accessor(key, pd));
      }
    }
    return node;
  };

  const list = (o: object, cls: string | undefined, n: number, d: number, at: (i: number) => unknown): Value => {
    const node: Value = { k: 'list', count: n, items: [] };
    if (cls) node.cls = cls;
    if (d >= L.depth || nodes >= L.nodes) {
      if (n) node.cut = n;
      return node;
    }
    seen.set(o, node);
    for (let i = 0; i < n; i++) {
      if (i >= L.items || nodes >= L.nodes) {
        node.cut = n - i;
        break;
      }
      node.items.push(walk(at(i), d + 1));
    }
    return node;
  };

  return walk(root, 0);
}

const REDACTED: Value = { k: 'const', v: '[redacted]' };

function accessor(n: string, p: PropertyDescriptor): Prop {
  return { n, vis: 'getter', val: { k: 'const', v: p.get ? (p.set ? '[Getter/Setter]' : '[Getter]') : '[Setter]' } };
}

function dom(el: Node, max: number): Value {
  const e = el as Element;
  if (el.nodeType != 1) return { k: 'dom', tag: el.nodeName, attrs: {}, html: String(el.textContent ?? '').slice(0, 2000) };
  const attrs: Record<string, string> = {};
  for (const a of Array.from(e.attributes).slice(0, 30)) attrs[a.name] = a.value.slice(0, 500);
  return { k: 'dom', tag: e.localName, attrs, html: e.outerHTML.slice(0, Math.min(max, 2000)) };
}

/** Compile hello.redact patterns (`*` wildcard, case-insensitive, whole key). */
export function redactor(patterns: unknown): RegExp | undefined {
  if (!Array.isArray(patterns) || !patterns.length) return undefined;
  const alt = patterns.map((p) => String(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
  return new RegExp(`^(?:${alt.join('|')})$`, 'i');
}

/** Value tree -> plain JSON (Ray-compat mode and previews). */
export function plain(v: Value): unknown {
  switch (v.k) {
    case 'null':
    case 'undef':
      return null;
    case 'str':
      return v.cut ? v.v + '…' : v.v;
    case 'bool':
    case 'int':
    case 'float':
    case 'const':
      return v.v;
    case 'list':
      return v.items.map(plain);
    case 'map':
      return Object.fromEntries(v.entries.map(([k, x]) => [typeof k == 'object' ? JSON.stringify(plain(k)) : k, plain(x)]));
    case 'obj':
      return Object.fromEntries(v.props.map((p) => [p.n, plain(p.val)]));
    case 'ref':
      return `[Circular ${v.cls || ''}]`.replace(' ]', ']');
    case 'fn':
      return `[Function ${v.name}]`;
    case 'date':
      return v.iso;
    case 'err':
      return { name: v.name, message: v.message, stack: v.stack };
    case 'dom':
      return v.html ?? `<${v.tag}>`;
  }
}
