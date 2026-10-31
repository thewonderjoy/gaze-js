import { describe, expect, it } from 'vitest';
import { LIMITS, plain, redactor, serialize } from '../src/core/serialize.js';
import type { Value } from '../src/core/types.js';
import { expectValidValue } from './helpers.js';

const ser = (v: unknown, limits = LIMITS) => {
  const out = serialize(v, limits);
  expectValidValue(out);
  return out;
};

describe('serialize: primitives', () => {
  it('maps every primitive to its RFC-0001 §5.1 kind', () => {
    expect(ser(null)).toEqual({ k: 'null' });
    expect(ser(undefined)).toEqual({ k: 'undef' });
    expect(ser(true)).toEqual({ k: 'bool', v: true });
    expect(ser(42)).toEqual({ k: 'int', v: 42 });
    expect(ser(3.14)).toEqual({ k: 'float', v: 3.14 });
    expect(ser(NaN)).toEqual({ k: 'float', v: 'NaN' });
    expect(ser(Infinity)).toEqual({ k: 'float', v: 'INF' });
    expect(ser(-Infinity)).toEqual({ k: 'float', v: '-INF' });
    expect(ser(-0)).toEqual({ k: 'float', v: '-0' });
    expect(ser(2 ** 60)).toEqual({ k: 'float', v: 2 ** 60 });
    expect(ser(9007199254740993n)).toEqual({ k: 'int', v: '9007199254740993' });
    expect(ser('hi')).toEqual({ k: 'str', v: 'hi' });
    expect(ser(Symbol('s'))).toEqual({ k: 'const', v: 'Symbol(s)' });
  });

  it('cuts long strings at 16 KiB and never splits a surrogate pair', () => {
    const v = ser('x'.repeat(20000)) as Extract<Value, { k: 'str' }>;
    expect(v.v.length).toBe(16384);
    expect(v.cut).toBe(20000 - 16384);
    expect(v.len).toBe(20000);
    const emoji = 'a'.repeat(16383) + '😀' + 'b';
    const e = ser(emoji) as Extract<Value, { k: 'str' }>;
    expect(e.v.length).toBe(16383);
    expect(e.cut).toBe(emoji.length - 16383);
  });

  it('describes functions without calling them', () => {
    function named() {}
    async function a() {}
    function* g() {}
    async function* ag() {}
    expect(ser(named)).toEqual({ k: 'fn', name: 'named' });
    expect(ser(a)).toEqual({ k: 'fn', name: 'a', async: true });
    expect(ser(g)).toEqual({ k: 'fn', name: 'g', gen: true });
    expect(ser(ag)).toEqual({ k: 'fn', name: 'ag', async: true, gen: true });
    expect(ser(() => 1)).toMatchObject({ k: 'fn' });
  });
});

describe('serialize: objects', () => {
  it('plain objects become obj with pub props', () => {
    expect(ser({ a: 1, b: 'two' })).toEqual({
      k: 'obj',
      cls: 'Object',
      props: [
        { n: 'a', vis: 'pub', val: { k: 'int', v: 1 } },
        { n: 'b', vis: 'pub', val: { k: 'str', v: 'two' } },
      ],
    });
    expect(ser(Object.create(null))).toEqual({ k: 'obj', cls: 'Object', props: [] });
  });

  it('never invokes getters (own or prototype) and lists them as getter props', () => {
    let calls = 0;
    class Cart {
      items = [1];
      get total() {
        calls++;
        return 1;
      }
    }
    const o = {
      get secret() {
        calls++;
        return 's';
      },
      set only(_v: number) {},
    };
    const c = ser(new Cart());
    const v = ser(o);
    expect(calls).toBe(0);
    expect(c).toMatchObject({ k: 'obj', cls: 'Cart' });
    expect((c as any).props).toContainEqual({ n: 'total', vis: 'getter', val: { k: 'const', v: '[Getter]' } });
    expect((v as any).props).toEqual([
      { n: 'secret', vis: 'getter', val: { k: 'const', v: '[Getter]' } },
      { n: 'only', vis: 'getter', val: { k: 'const', v: '[Setter]' } },
    ]);
  });

  it('turns cycles and repeated objects into refs to an id', () => {
    const a: any = { name: 'a' };
    a.self = a;
    const shared = { x: 1 };
    const v = ser({ a, list: [shared, shared] }) as any;
    const aNode = v.props[0].val;
    expect(aNode.id).toBe(1);
    expect(aNode.props[1]).toEqual({ n: 'self', vis: 'pub', val: { k: 'ref', to: 1, cls: 'Object' } });
    const list = v.props[1].val;
    expect(list.items[0].id).toBe(2);
    expect(list.items[1]).toEqual({ k: 'ref', to: 2, cls: 'Object' });
  });

  it('handles Map, Set, Date, RegExp, URL, Error with cause, typed arrays, ArrayBuffer', () => {
    expect(ser(new Map<unknown, unknown>([['a', 1], [2, 'b'], [{ k: 1 }, true]]))).toEqual({
      k: 'map',
      cls: 'Map',
      count: 3,
      entries: [
        ['a', { k: 'int', v: 1 }],
        [2, { k: 'str', v: 'b' }],
        [{ k: 'obj', cls: 'Object', props: [{ n: 'k', vis: 'pub', val: { k: 'int', v: 1 } }] }, { k: 'bool', v: true }],
      ],
    });
    expect(ser(new Set([1, 'x']))).toEqual({ k: 'list', cls: 'Set', count: 2, items: [{ k: 'int', v: 1 }, { k: 'str', v: 'x' }] });
    expect(ser(new Date('2026-10-31T06:30:00.000Z'))).toEqual({ k: 'date', iso: '2026-10-31T06:30:00.000Z' });
    expect(ser(new Date(NaN))).toEqual({ k: 'date', iso: 'Invalid Date' });
    expect(ser(/a+b/gi)).toEqual({ k: 'const', v: '/a+b/gi' });
    expect(ser(new URL('https://x.test/a?b=1'))).toEqual({ k: 'const', v: 'https://x.test/a?b=1' });
    const err = new TypeError('outer', { cause: new Error('inner') });
    const e = ser(err) as any;
    expect(e).toMatchObject({ k: 'err', name: 'TypeError', message: 'outer', cause: { k: 'err', name: 'Error', message: 'inner' } });
    expect(e.stack).toContain('outer');
    expect(ser(new Uint8Array([1, 2]))).toEqual({ k: 'list', cls: 'Uint8Array', count: 2, items: [{ k: 'int', v: 1 }, { k: 'int', v: 2 }] });
    expect(ser(new BigInt64Array([5n]))).toEqual({ k: 'list', cls: 'BigInt64Array', count: 1, items: [{ k: 'int', v: '5' }] });
    expect(ser(new Uint8Array([7]).buffer)).toEqual({ k: 'list', cls: 'ArrayBuffer', count: 1, items: [{ k: 'int', v: 7 }] });
    expect(ser(new DataView(new ArrayBuffer(4)))).toEqual({ k: 'const', v: 'DataView(4)' });
    expect(ser(Promise.resolve())).toEqual({ k: 'const', v: 'Promise' });
    expect(ser(new WeakMap())).toEqual({ k: 'const', v: 'WeakMap' });
    expect(ser([1, , 3])).toEqual({ k: 'list', count: 3, items: [{ k: 'int', v: 1 }, { k: 'undef' }, { k: 'int', v: 3 }] });
  });

  it('serializes DOM nodes as dom (tag, attrs, truncated outerHTML)', () => {
    const G = globalThis as any;
    const had = 'Node' in G;
    class FakeNode {
      nodeType = 1;
      localName = 'button';
      nodeName = 'BUTTON';
      attributes = [
        { name: 'id', value: 'checkout' },
        { name: 'class', value: 'btn' },
      ];
      outerHTML = '<button id="checkout" class="btn">Pay</button>';
    }
    G.Node = FakeNode;
    try {
      expect(ser(new FakeNode())).toEqual({
        k: 'dom',
        tag: 'button',
        attrs: { id: 'checkout', class: 'btn' },
        html: '<button id="checkout" class="btn">Pay</button>',
      });
    } finally {
      if (!had) delete G.Node;
    }
  });

  it('enforces depth 8, 200 items and the node budget with explicit cut counts', () => {
    let deep: any = { v: 1 };
    for (let i = 0; i < 12; i++) deep = { d: deep };
    let n: any = ser(deep);
    let depth = 0;
    while (n.props?.length) {
      n = n.props[0].val;
      depth++;
    }
    expect(depth).toBe(8);
    expect(n).toEqual({ k: 'obj', cls: 'Object', props: [], cut: 1 });

    const big = ser(Array.from({ length: 1000 }, (_, i) => i)) as any;
    expect(big.items.length).toBe(200);
    expect(big.count).toBe(1000);
    expect(big.cut).toBe(800);

    const wide = ser(Object.fromEntries(Array.from({ length: 250 }, (_, i) => ['k' + i, i]))) as any;
    expect(wide.props.length).toBe(200);
    expect(wide.cut).toBe(50);

    const many = Array.from({ length: 100 }, () => Array.from({ length: 100 }, (_, i) => i));
    const m = ser(many, { ...LIMITS, nodes: 500 }) as any;
    const total = (v: any): number => 1 + (v.items ?? []).reduce((s: number, x: any) => s + total(x), 0);
    expect(total(m)).toBeLessThanOrEqual(501 + 100);
    expect(m.cut).toBeGreaterThan(0);
  });

  it('a throwing Proxy (revoked, hostile traps) becomes [Unserializable] instead of throwing', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    expect(ser({ a: proxy, b: hostile, c: 1 })).toEqual({
      k: 'obj',
      cls: 'Object',
      props: [
        { n: 'a', vis: 'pub', val: { k: 'const', v: '[Unserializable]' } },
        { n: 'b', vis: 'pub', val: { k: 'const', v: '[Unserializable]' } },
        { n: 'c', vis: 'pub', val: { k: 'int', v: 1 } },
      ],
    });
  });

  it('serializes synchronously: later mutation does not change the dump', () => {
    const o = { n: 1 };
    const v = ser(o);
    o.n = 2;
    expect((v as any).props[0].val).toEqual({ k: 'int', v: 1 });
  });

  it('masks redacted keys', () => {
    const re = redactor(['password', '*token'])!;
    const v = serialize({ password: 'x', apiToken: 'y', user: 'z', m: new Map([['password', 1]]) }, LIMITS, re) as any;
    expect(v.props.map((p: any) => p.val.v)).toEqual(['[redacted]', '[redacted]', 'z', undefined]);
    expect(v.props[3].val.entries[0][1]).toEqual({ k: 'const', v: '[redacted]' });
  });
});

describe('plain()', () => {
  it('converts a Value tree back to plain JSON for the Ray wire', () => {
    const a: any = { list: [1, 'x', null, undefined, true], when: new Date(0), m: new Map([['k', 1]]) };
    a.self = a;
    expect(plain(serialize(a))).toEqual({
      list: [1, 'x', null, null, true],
      when: '1970-01-01T00:00:00.000Z',
      m: { k: 1 },
      self: '[Circular Object]',
    });
  });
});
