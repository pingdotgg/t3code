// Base32 is ideal for physical names because it's denser than hex (5 bits per char vs 4)
// and compatible with DNS/S3 (as opposed to base64 which contains uppercase letters and symbols).

// base32.ts
// Concise, fast RFC 4648 Base32 encoder (no padding), lowercase output.
// Charset: a-z2-7 (DNS/S3 friendly)
const ALPH = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Encode bytes into RFC4648 Base32 (no padding), lowercase.
 *
 * Performance notes:
 * - O(n) single pass, no big-int
 * - Avoids per-byte string concatenation by using a char array
 */
export function base32(bytes: Uint8Array): string {
  const n = bytes.length;
  if (n === 0) return "";

  // Base32 length without padding: ceil(n*8/5)
  const outLen = ((n * 8 + 4) / 5) | 0;
  const out = Array.from<string>({ length: outLen });

  let buffer = 0;
  let bits = 0;
  let o = 0;

  for (let i = 0; i < n; i++) {
    buffer = (buffer << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      out[o++] = ALPH[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out[o++] = ALPH[(buffer << (5 - bits)) & 31];
  }

  // outLen computed as exact ceiling; o should match, but slice defensively.
  return o === outLen ? out.join("") : out.slice(0, o).join("");
}
