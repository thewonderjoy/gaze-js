// Ids. crypto.randomUUID only exists in secure contexts (http://myapp.test is not one) and gives v4,
// so ids are UUID v7 built from crypto.getRandomValues, with Math.random as the last resort.
// Never call these at module scope: workerd forbids random values during global initialisation.

export function rand(n: number): Uint8Array {
  const b = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c && c.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < n; i++) b[i] = Math.random() * 256;
  return b;
}

export function hex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i]! < 16 ? '0' : '') + b[i]!.toString(16);
  return s;
}

/** UUID v7: 48-bit Unix ms timestamp, version 7, variant 10, 74 random bits. */
export function uuid7(t: number = Date.now()): string {
  const b = rand(16);
  b[0] = t / 2 ** 40;
  b[1] = t / 2 ** 32;
  b[2] = t >>> 24;
  b[3] = t >>> 16;
  b[4] = t >>> 8;
  b[5] = t;
  b[6] = (b[6]! & 15) | 112;
  b[8] = (b[8]! & 63) | 128;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** W3C trace id (32 lowercase hex). */
export const traceId = (): string => hex(rand(16));
