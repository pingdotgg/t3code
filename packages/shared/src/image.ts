// Match PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES so unsupported images remain sendable as files.
const IMAGE_MIME_TYPE_BY_EXTENSION = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

const SUPPORTED_IMAGE_MIME_TYPES = new Set(IMAGE_MIME_TYPE_BY_EXTENSION.values());

export const GENERIC_MIME_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
  // macOS and Windows label TypeScript `.ts` files as MPEG transport streams, which browsers can't play.
  "video/mp2t",
  "video/vnd.dlna.mpeg-tts",
]);

export function isSvgAttachment(attachment: {
  readonly name: string;
  readonly mimeType: string;
}): boolean {
  const mimeType = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mimeType === "image/svg+xml" ||
    ((mimeType === "" || GENERIC_MIME_TYPES.has(mimeType)) && /\.svg$/i.test(attachment.name))
  );
}

export function imageMimeType(attachment: {
  readonly name: string;
  readonly mimeType: string;
}): string | null {
  const mimeType = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return mimeType;
  if (mimeType.startsWith("image/")) return null;
  // Infer from filenames only for missing or generic MIME types; extensions must not override a definite type.
  if (mimeType !== "" && !GENERIC_MIME_TYPES.has(mimeType)) return null;
  const dotIndex = attachment.name.lastIndexOf(".");
  return dotIndex < 0
    ? null
    : (IMAGE_MIME_TYPE_BY_EXTENSION.get(
        attachment.name
          .slice(dotIndex + 1)
          .trim()
          .toLowerCase(),
      ) ?? null);
}

function normalizeImageMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/vnd.microsoft.icon") return "image/x-icon";
  return normalized;
}

function imageMimeTypesCompatible(declared: string, detected: string): boolean {
  if (declared === "" || GENERIC_MIME_TYPES.has(declared)) {
    return true;
  }
  const normalizedDeclared = normalizeImageMimeType(declared);
  const normalizedDetected = normalizeImageMimeType(detected);
  if (normalizedDeclared === normalizedDetected) {
    return true;
  }
  return (
    (normalizedDeclared === "image/heic" && normalizedDetected === "image/heif") ||
    (normalizedDeclared === "image/heif" && normalizedDetected === "image/heic")
  );
}

function readAscii4(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

export function sniffImageMimeType(bytes: Uint8Array): string | null {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 12 &&
    readAscii4(bytes, 0) === "RIFF" &&
    readAscii4(bytes, 8) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.byteLength >= 14 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x00
  ) {
    return "image/x-icon";
  }
  if (
    bytes.byteLength >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return "image/tiff";
  }
  if (bytes.byteLength >= 12 && readAscii4(bytes, 4) === "ftyp") {
    const brand = readAscii4(bytes, 8);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "hevx") {
      return "image/heic";
    }
    if (brand === "mif1" || brand === "msf1" || brand === "heif") return "image/heif";
  }
  return null;
}

function isBase64Byte(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f ||
    code === 0x3d
  );
}

function isAsciiWhitespaceByte(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

const asciiDecoder = new TextDecoder("ascii");

function decodeAsciiSlice(bytes: Uint8Array, start: number, end: number): string {
  return asciiDecoder.decode(bytes.subarray(start, end));
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

function extractStrictBase64(bytes: Uint8Array, startIndex: number): string | null {
  const chunks: Array<string> = [];
  let runStart = -1;
  let totalLength = 0;

  for (let index = startIndex; index < bytes.byteLength; index += 1) {
    const code = bytes[index]!;
    if (isBase64Byte(code)) {
      if (runStart === -1) runStart = index;
      continue;
    }
    if (!isAsciiWhitespaceByte(code)) return null;
    if (runStart !== -1) {
      chunks.push(decodeAsciiSlice(bytes, runStart, index));
      totalLength += index - runStart;
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    chunks.push(decodeAsciiSlice(bytes, runStart, bytes.byteLength));
    totalLength += bytes.byteLength - runStart;
  }

  if (totalLength === 0 || totalLength % 4 !== 0) return null;
  const base64 = chunks.length === 1 ? chunks[0]! : chunks.join("");
  const firstPad = base64.indexOf("=");
  if (firstPad !== -1) {
    if (base64.length - firstPad > 2) return null;
    for (let index = firstPad; index < base64.length; index += 1) {
      if (base64.charCodeAt(index) !== 0x3d) return null;
    }
  }
  return base64;
}

export function decodeBase64ImagePayload(bytes: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly detectedMimeType: string;
  readonly declaredDataUrlMimeType?: string;
} | null {
  let start = 0;
  while (start < bytes.byteLength && isAsciiWhitespaceByte(bytes[start]!)) {
    start += 1;
  }
  if (start >= bytes.byteLength) return null;

  let declaredDataUrlMimeType: string | undefined;
  let base64Start = start;

  if (
    bytes.byteLength - start >= 5 &&
    (bytes[start] === 0x64 || bytes[start] === 0x44) &&
    (bytes[start + 1] === 0x61 || bytes[start + 1] === 0x41) &&
    (bytes[start + 2] === 0x74 || bytes[start + 2] === 0x54) &&
    (bytes[start + 3] === 0x61 || bytes[start + 3] === 0x41) &&
    bytes[start + 4] === 0x3a
  ) {
    let commaIndex = -1;
    const headerScanLimit = Math.min(bytes.byteLength, start + 256);
    for (let index = start + 5; index < headerScanLimit; index += 1) {
      const code = bytes[index]!;
      if (code === 0x2c) {
        commaIndex = index;
        break;
      }
      if (code > 0x7f) return null;
    }
    if (commaIndex === -1) return null;
    const header = decodeAsciiSlice(bytes, start + 5, commaIndex);
    const headerParts = header
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (headerParts.length < 2 || headerParts.at(-1)?.toLowerCase() !== "base64") {
      return null;
    }
    const headerMime = normalizeImageMimeType(headerParts[0] ?? "");
    if (!headerMime.startsWith("image/")) return null;
    declaredDataUrlMimeType = headerMime;
    base64Start = commaIndex + 1;
  }

  const base64 = extractStrictBase64(bytes, base64Start);
  if (!base64) return null;

  const decoded = decodeBase64ToBytes(base64);
  const detectedMimeType = sniffImageMimeType(decoded);
  if (!detectedMimeType) return null;

  return declaredDataUrlMimeType !== undefined
    ? { bytes: decoded, detectedMimeType, declaredDataUrlMimeType }
    : { bytes: decoded, detectedMimeType };
}

export type ValidateImageBytesResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly mimeType: string;
      readonly decodedFromBase64: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export function validateAndNormalizeImageBytes(input: {
  readonly bytes: Uint8Array;
  readonly declaredMimeType: string;
}): ValidateImageBytesResult {
  const sniffed = sniffImageMimeType(input.bytes);
  if (sniffed !== null) {
    if (!imageMimeTypesCompatible(input.declaredMimeType, sniffed)) {
      return {
        ok: false,
        reason: `Image content (${sniffed}) does not match declared MIME type (${normalizeImageMimeType(input.declaredMimeType)}).`,
      };
    }
    return {
      ok: true,
      bytes: input.bytes,
      mimeType: sniffed,
      decodedFromBase64: false,
    };
  }

  const decoded = decodeBase64ImagePayload(input.bytes);
  if (decoded !== null) {
    if (
      decoded.declaredDataUrlMimeType !== undefined &&
      !imageMimeTypesCompatible(decoded.declaredDataUrlMimeType, decoded.detectedMimeType)
    ) {
      return {
        ok: false,
        reason: `Decoded image content (${decoded.detectedMimeType}) does not match data URL MIME type (${decoded.declaredDataUrlMimeType}).`,
      };
    }
    if (!imageMimeTypesCompatible(input.declaredMimeType, decoded.detectedMimeType)) {
      return {
        ok: false,
        reason: `Decoded image content (${decoded.detectedMimeType}) does not match declared MIME type (${normalizeImageMimeType(input.declaredMimeType)}).`,
      };
    }
    return {
      ok: true,
      bytes: decoded.bytes,
      mimeType: decoded.detectedMimeType,
      decodedFromBase64: true,
    };
  }

  return {
    ok: false,
    reason: "Uploaded image payload is not a valid supported image.",
  };
}
