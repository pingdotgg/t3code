/**
 * A minimal DER encoder/decoder — just enough ASN.1 for a PKCS#10
 * certificate request (encode) and reading a certificate's serial,
 * validity, issuer and subject alternative names (decode). Pure
 * TypeScript; no native code, no dependency, works on workerd.
 *
 * @internal
 */

export const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const encodeLength = (n: number): Uint8Array => {
  if (n < 0x80) return Uint8Array.of(n);
  if (n < 0x100) return Uint8Array.of(0x81, n);
  if (n < 0x10000) return Uint8Array.of(0x82, n >>> 8, n & 0xff);
  return Uint8Array.of(0x83, n >>> 16, (n >>> 8) & 0xff, n & 0xff);
};

/** Tag-length-value. */
export const tlv = (tag: number, body: Uint8Array): Uint8Array =>
  concat(Uint8Array.of(tag), encodeLength(body.length), body);

export const sequence = (...items: ReadonlyArray<Uint8Array>) =>
  tlv(0x30, concat(...items));
export const set = (...items: ReadonlyArray<Uint8Array>) =>
  tlv(0x31, concat(...items));
export const octetString = (body: Uint8Array) => tlv(0x04, body);
export const bitString = (body: Uint8Array) =>
  tlv(0x03, concat(Uint8Array.of(0), body));
export const nullValue = () => Uint8Array.of(0x05, 0x00);
export const ia5String = (text: string) =>
  tlv(0x16, new TextEncoder().encode(text));
export const utf8String = (text: string) =>
  tlv(0x0c, new TextEncoder().encode(text));
/** Context-specific constructed tag `[n]` (implicit or explicit, caller's choice of body). */
export const contextTag = (n: number, body: Uint8Array) => tlv(0xa0 | n, body);
/** Context-specific primitive tag `[n]` (e.g. GeneralName dNSName is `[2]`). */
export const contextPrimitive = (n: number, body: Uint8Array) =>
  tlv(0x80 | n, body);

/** INTEGER from a non-negative number or big-endian magnitude bytes. */
export const integer = (value: number | Uint8Array): Uint8Array => {
  if (typeof value === "number") {
    if (value === 0) return tlv(0x02, Uint8Array.of(0));
    const bytes: number[] = [];
    let n = value;
    while (n > 0) {
      bytes.unshift(n & 0xff);
      n = Math.floor(n / 256);
    }
    if (bytes[0]! & 0x80) bytes.unshift(0);
    return tlv(0x02, Uint8Array.from(bytes));
  }
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const magnitude = value.subarray(start);
  return tlv(
    0x02,
    magnitude[0]! & 0x80 ? concat(Uint8Array.of(0), magnitude) : magnitude,
  );
};

/** OBJECT IDENTIFIER from dotted notation. */
export const oid = (dotted: string): Uint8Array => {
  const parts = dotted.split(".").map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const stack: number[] = [part & 0x7f];
    let n = Math.floor(part / 128);
    while (n > 0) {
      stack.unshift((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    bytes.push(...stack);
  }
  return tlv(0x06, Uint8Array.from(bytes));
};

// =============================================================================
// Decoding
// =============================================================================

export interface Node {
  readonly tag: number;
  /** Offset of the first content byte. */
  readonly start: number;
  /** Offset one past the last content byte. */
  readonly end: number;
  readonly bytes: Uint8Array;
}

export const read = (bytes: Uint8Array, offset: number): Node => {
  const tag = bytes[offset]!;
  let cursor = offset + 1;
  let length = bytes[cursor++]!;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[cursor++]!;
  }
  return { tag, start: cursor, end: cursor + length, bytes };
};

/** The children of a constructed node, in order. */
export const children = (node: Node): Node[] => {
  const out: Node[] = [];
  let cursor = node.start;
  while (cursor < node.end) {
    const child = read(node.bytes, cursor);
    out.push(child);
    cursor = child.end;
  }
  return out;
};

export const content = (node: Node): Uint8Array =>
  node.bytes.subarray(node.start, node.end);

export const decodeOid = (node: Node): string => {
  const body = content(node);
  const first = body[0]!;
  const parts = [Math.floor(first / 40), first % 40];
  let n = 0;
  for (let i = 1; i < body.length; i++) {
    n = n * 128 + (body[i]! & 0x7f);
    if ((body[i]! & 0x80) === 0) {
      parts.push(n);
      n = 0;
    }
  }
  // OIDs under joint-iso-itu-t(2) can have a first arc ≥ 2 with large second arcs.
  if (first >= 80) {
    parts[0] = 2;
    parts[1] = first - 80;
  }
  return parts.join(".");
};

/** Parse UTCTime (`YYMMDDHHMMSSZ`) or GeneralizedTime (`YYYYMMDDHHMMSSZ`). */
export const decodeTime = (node: Node): Date => {
  const text = new TextDecoder().decode(content(node));
  const generalized = node.tag === 0x18;
  const year = generalized
    ? Number(text.slice(0, 4))
    : (() => {
        const yy = Number(text.slice(0, 2));
        return yy < 50 ? 2000 + yy : 1900 + yy;
      })();
  const rest = generalized ? text.slice(4) : text.slice(2);
  const month = Number(rest.slice(0, 2));
  const day = Number(rest.slice(2, 4));
  const hour = Number(rest.slice(4, 6));
  const minute = Number(rest.slice(6, 8));
  const second = Number(rest.slice(8, 10)) || 0;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
};

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
