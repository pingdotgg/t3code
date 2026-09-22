import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Pull from "effect/Pull";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const BT709_FULL_RANGE_CICP = [1, 1, 0, 1] as const;
const SRGB_GAMMA = [0, 0, 177, 143] as const;
const SRGB_CHROMATICITIES = [
  0, 0, 122, 38, 0, 0, 128, 132, 0, 0, 250, 0, 0, 0, 128, 232, 0, 0, 117, 48, 0, 0, 234, 96, 0, 0,
  58, 152, 0, 0, 23, 112,
] as const;
/** GitHub caps image uploads well below this; anything larger streams through untouched. */
export const MAX_NORMALIZED_PNG_BYTES = 25 * 1024 * 1024;
const NORMALIZED_PNG_BODY_TIMEOUT = Duration.seconds(30);
const INITIAL_NORMALIZED_PNG_BUFFER_BYTES = 64 * 1024;
/**
 * A cICP chunk precedes IDAT, and every chunk before it is small metadata, so this much of a
 * PNG is enough to know whether the rest of the body is worth buffering at all.
 */
export const PNG_CICP_PEEK_BYTES = 64 * 1024;

export class GitHubMediaBodyTooLargeError extends Schema.TaggedError<GitHubMediaBodyTooLargeError>()(
  "GitHubMediaBodyTooLargeError",
  {
    maxBytes: Schema.Number,
  },
) {}

function bytesEqualAt(bytes: Uint8Array, offset: number, expected: ReadonlyArray<number>): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Newer Chromium versions honor cICP ahead of legacy PNG color metadata. Some macOS screenshots
 * describe the same pixels as full-range BT.709 in cICP and as sRGB in gAMA/cHRM. Remove only the
 * conflicting cICP chunk from that exact combination so decoders use the existing sRGB metadata.
 */
export function stripConflictingBt709Cicp(bytes: Uint8Array): Uint8Array {
  if (bytes.length < PNG_SIGNATURE.length || !bytesEqualAt(bytes, 0, PNG_SIGNATURE)) return bytes;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cicpOffset = -1;
  let hasSrgbGamma = false;
  let hasSrgbChromaticities = false;
  let offset: number = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const dataLength = view.getUint32(offset, false);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + dataLength + 4;
    if (chunkEnd > bytes.length) return bytes;

    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "cICP") {
      // PNG permits one cICP chunk. Leave duplicate or other profiles untouched.
      if (
        cicpOffset !== -1 ||
        dataLength !== BT709_FULL_RANGE_CICP.length ||
        !bytesEqualAt(bytes, dataOffset, BT709_FULL_RANGE_CICP)
      )
        return bytes;
      cicpOffset = offset;
    } else if (type === "gAMA") {
      hasSrgbGamma ||=
        dataLength === SRGB_GAMMA.length && bytesEqualAt(bytes, dataOffset, SRGB_GAMMA);
    } else if (type === "cHRM") {
      hasSrgbChromaticities ||=
        dataLength === SRGB_CHROMATICITIES.length &&
        bytesEqualAt(bytes, dataOffset, SRGB_CHROMATICITIES);
    }
    offset = chunkEnd;
  }

  if (offset !== bytes.length || cicpOffset === -1 || !hasSrgbGamma || !hasSrgbChromaticities)
    return bytes;
  const chunkLength = 12 + BT709_FULL_RANGE_CICP.length;
  bytes.copyWithin(cicpOffset, cicpOffset + chunkLength);
  return bytes.subarray(0, bytes.length - chunkLength);
}

type MediaBody = HttpClientResponse.HttpClientResponse["stream"];

/** Upstream already said the body is past the bound, so there is nothing to peek at or buffer. */
export function declaresOversizedBody(response: HttpClientResponse.HttpClientResponse): boolean {
  const declaredLength = Number(response.headers["content-length"]);
  return Number.isFinite(declaredLength) && declaredLength > MAX_NORMALIZED_PNG_BYTES;
}

/**
 * Walks the chunk headers of a PNG prefix. "unknown" means the prefix ended before a decision:
 * a cICP chunk was not seen yet and IDAT was not reached either.
 */
export function pngCicpPresence(prefix: Uint8Array): "present" | "absent" | "unknown" {
  if (prefix.length < PNG_SIGNATURE.length) return "unknown";
  if (!bytesEqualAt(prefix, 0, PNG_SIGNATURE)) return "absent";
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  let offset: number = PNG_SIGNATURE.length;
  while (offset + 8 <= prefix.length) {
    const type = String.fromCharCode(...prefix.subarray(offset + 4, offset + 8));
    if (type === "cICP") return "present";
    if (type === "IDAT" || type === "IEND") return "absent";
    offset += 12 + view.getUint32(offset, false);
  }
  return "unknown";
}

/**
 * Reads only as much of a PNG body as it takes to tell whether a cICP chunk is present, so a
 * screenshot without one streams through with nothing but its first chunks in memory. The body
 * comes back as the peeked prefix plus the untouched remainder, still bound to the caller's
 * scope like the response stream it came from.
 */
export const peekPngCicp = Effect.fn("GitHubMediaNormalization.peekPngCicp")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const pull = yield* Stream.toPull(response.stream);
  const parts: Array<Uint8Array> = [];
  let head: Uint8Array = new Uint8Array(0);
  let presence = pngCicpPresence(head);
  let ended = false;
  while (presence === "unknown" && head.length < PNG_CICP_PEEK_BYTES) {
    const next = yield* pull.pipe(Pull.catchDone(() => Effect.succeed(null)));
    if (next === null) {
      ended = true;
      break;
    }
    parts.push(...next);
    head = concatBytes(parts);
    presence = pngCicpPresence(head);
  }
  const rest: MediaBody = ended ? Stream.empty : Stream.fromPull(Effect.succeed(pull));
  const body: MediaBody = Stream.concat(Stream.fromArray(parts), rest);
  return { presence, body };
});

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/**
 * Buffers one response body up to `MAX_NORMALIZED_PNG_BYTES` so the normalizer above can inspect
 * it. Only the narrow PNG case calls this; every other media response keeps streaming. Bodies
 * past the bound fail instead of growing: the route answers 502 and the client falls back to
 * the original URL, so a huge image still loads, just without normalization.
 */
export const readBoundedBody = Effect.fn("GitHubMediaNormalization.readBoundedBody")(function* (
  response: HttpClientResponse.HttpClientResponse,
  stream: MediaBody = response.stream,
) {
  const declaredLength = Number(response.headers["content-length"]);
  if (declaresOversizedBody(response)) {
    return yield* new GitHubMediaBodyTooLargeError({ maxBytes: MAX_NORMALIZED_PNG_BYTES });
  }

  const initialCapacity =
    Number.isSafeInteger(declaredLength) && declaredLength >= 0
      ? declaredLength
      : INITIAL_NORMALIZED_PNG_BUFFER_BYTES;
  let bytes = new Uint8Array(initialCapacity);
  let byteLength = 0;
  yield* stream.pipe(
    Stream.runForEach((chunk) => {
      const nextByteLength = byteLength + chunk.length;
      if (nextByteLength > MAX_NORMALIZED_PNG_BYTES) {
        return Effect.fail(
          new GitHubMediaBodyTooLargeError({ maxBytes: MAX_NORMALIZED_PNG_BYTES }),
        );
      }
      if (nextByteLength > bytes.length) {
        const nextCapacity = Math.min(
          MAX_NORMALIZED_PNG_BYTES,
          Math.max(nextByteLength, bytes.length * 2, INITIAL_NORMALIZED_PNG_BUFFER_BYTES),
        );
        const grown = new Uint8Array(nextCapacity);
        grown.set(bytes.subarray(0, byteLength));
        bytes = grown;
      }
      bytes.set(chunk, byteLength);
      byteLength = nextByteLength;
      return Effect.void;
    }),
    Effect.timeout(NORMALIZED_PNG_BODY_TIMEOUT),
  );

  return bytes.subarray(0, byteLength);
});
