function hexDigit(byte: number) {
  if (byte >= 48 && byte <= 57) return byte - 48;
  const lower = byte | 32;
  return lower >= 97 && lower <= 102 ? lower - 87 : -1;
}

// Data URL escapes are raw bytes, not UTF-8, so `%89` stays one byte. Compacts in place to keep
// large embedded resources out of JS number arrays.
function decodePercentBytes(payload: string) {
  const bytes = new TextEncoder().encode(payload);
  if (!payload.includes("%")) return bytes;
  let written = 0;
  for (let read = 0; read < bytes.length; read++) {
    const byte = bytes[read]!;
    if (byte === 37 && read + 2 < bytes.length) {
      const high = hexDigit(bytes[read + 1]!);
      const low = hexDigit(bytes[read + 2]!);
      if (high >= 0 && low >= 0) {
        bytes[written++] = high * 16 + low;
        read += 2;
        continue;
      }
    }
    bytes[written++] = byte;
  }
  return bytes.subarray(0, written);
}

function decodeBase64Bytes(payload: string) {
  const binary = atob(decodeURIComponent(payload));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decodes a `data:` URL without fetch(), which desktop's connect-src refuses for it.
 * Throws on a malformed URL; the message is English, for logs.
 */
export function decodeDataUrl(src: string): Blob {
  // A fragment is never part of the payload; a literal `#` in data must be escaped as `%23`.
  const url = src.split("#", 1)[0] ?? src;
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("Missing data URL payload.");
  const [mimeType = "", ...parameters] = url.slice("data:".length, comma).split(";");
  const payload = url.slice(comma + 1);
  // Base64 text is ASCII, so any escape that is not valid UTF-8 is malformed anyway.
  const isBase64 = parameters.some((parameter) => parameter.trim().toLowerCase() === "base64");
  const bytes = isBase64 ? decodeBase64Bytes(payload) : decodePercentBytes(payload);
  return new Blob([bytes], { type: mimeType || "text/plain" });
}
