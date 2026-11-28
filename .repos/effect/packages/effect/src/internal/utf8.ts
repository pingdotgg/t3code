// UTF-8 decoding for binary codecs, with a fast path for short ASCII strings.

const fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const lax = new TextDecoder("utf-8", { ignoreBOM: true })

// Up to this length, ASCII is decoded by hand, which avoids the fixed cost of
// `TextDecoder`.
const INLINE_LIMIT = 32

/**
 * The string of the UTF-8 bytes from `start` to `end`, or `undefined` for
 * invalid UTF-8. A byte order mark is kept.
 * Requires integer offsets satisfying `0 <= start <= end <= buf.length`.
 *
 * @internal
 */
export const decode = (buf: Uint8Array, start: number, end: number): string | undefined => {
  const len = end - start
  if (len === 0) return ""
  if (len <= INLINE_LIMIT) {
    const ascii = decodeAscii(buf, start, end)
    if (ascii !== undefined) return ascii
  }
  try {
    return fatal.decode(buf.subarray(start, end))
  } catch {
    return undefined
  }
}

/**
 * The string of the UTF-8 bytes from `start` to `end`, with replacement
 * characters for invalid UTF-8. A byte order mark is kept.
 *
 * @internal
 */
export const decodeLax = (buf: Uint8Array, start: number, end: number): string => {
  if (end - start <= INLINE_LIMIT) {
    const ascii = decodeAscii(buf, start, end)
    if (ascii !== undefined) return ascii
  }
  return lax.decode(buf.subarray(start, end))
}

// Sixteen and eight code unit blocks, checking their high bits together and
// giving up on the first non-ASCII byte, then one call for the 0-7 tail.
const decodeAscii = (buf: Uint8Array, start: number, end: number): string | undefined => {
  let out = ""
  let i = start
  for (; i + 16 <= end; i += 16) {
    const a = buf[i], b = buf[i + 1], c = buf[i + 2], d = buf[i + 3]
    const e = buf[i + 4], f = buf[i + 5], g = buf[i + 6], h = buf[i + 7]
    const a2 = buf[i + 8], b2 = buf[i + 9], c2 = buf[i + 10], d2 = buf[i + 11]
    const e2 = buf[i + 12], f2 = buf[i + 13], g2 = buf[i + 14], h2 = buf[i + 15]
    if ((a | b | c | d | e | f | g | h | a2 | b2 | c2 | d2 | e2 | f2 | g2 | h2) > 0x7F) return undefined
    out += String.fromCharCode(a, b, c, d, e, f, g, h, a2, b2, c2, d2, e2, f2, g2, h2)
  }
  if (i + 8 <= end) {
    const a = buf[i], b = buf[i + 1], c = buf[i + 2], d = buf[i + 3]
    const e = buf[i + 4], f = buf[i + 5], g = buf[i + 6], h = buf[i + 7]
    if ((a | b | c | d | e | f | g | h) > 0x7F) return undefined
    out += String.fromCharCode(a, b, c, d, e, f, g, h)
    i += 8
  }
  switch (end - i) {
    case 0:
      return out
    case 1: {
      const a = buf[i]
      if (a > 0x7F) return undefined
      return out + String.fromCharCode(a)
    }
    case 2: {
      const a = buf[i], b = buf[i + 1]
      if ((a | b) > 0x7F) return undefined
      return out + String.fromCharCode(a, b)
    }
    case 3: {
      const a = buf[i], b = buf[i + 1], c = buf[i + 2]
      if ((a | b | c) > 0x7F) return undefined
      return out + String.fromCharCode(a, b, c)
    }
    case 4: {
      const a = buf[i], b = buf[i + 1], c = buf[i + 2], d = buf[i + 3]
      if ((a | b | c | d) > 0x7F) return undefined
      return out + String.fromCharCode(a, b, c, d)
    }
    case 5: {
      const a = buf[i], b = buf[i + 1], c = buf[i + 2], d = buf[i + 3], e = buf[i + 4]
      if ((a | b | c | d | e) > 0x7F) return undefined
      return out + String.fromCharCode(a, b, c, d, e)
    }
    case 6: {
      const a = buf[i], b = buf[i + 1], c = buf[i + 2], d = buf[i + 3]
      const e = buf[i + 4], f = buf[i + 5]
      if ((a | b | c | d | e | f) > 0x7F) return undefined
      return out + String.fromCharCode(a, b, c, d, e, f)
    }
    default: {
      const a = buf[i], b = buf[i + 1], c = buf[i + 2], d = buf[i + 3]
      const e = buf[i + 4], f = buf[i + 5], g = buf[i + 6]
      if ((a | b | c | d | e | f | g) > 0x7F) return undefined
      return out + String.fromCharCode(a, b, c, d, e, f, g)
    }
  }
}
