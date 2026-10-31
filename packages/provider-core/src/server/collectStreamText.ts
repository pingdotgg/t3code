import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as NodeBuffer from "node:buffer";

export interface CollectedUint8StreamText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
  readonly invalidUtf8: boolean;
}

export interface DecodeStreamTextOptions {
  /** Decodes output that is not UTF-8, such as a Windows CLI writing its ANSI code page. */
  readonly legacyEncoding?: string | null | undefined;
  /** Our own byte limit can cut a multi-byte character, so that tail is no evidence of another encoding. */
  readonly truncated?: boolean | undefined;
}

const decodeWithEncoding = (bytes: Uint8Array, encoding: string): string => {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString("utf8");
  }
};

/** Stream mode holds a multi-byte character our byte limit cut, instead of rejecting the buffer. */
const isUtf8Prefix = (bytes: Uint8Array): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
};

export const decodeUtf8 = (
  bytes: Uint8Array,
  options: DecodeStreamTextOptions = {},
): Pick<CollectedUint8StreamText, "text" | "invalidUtf8"> => {
  const invalidUtf8 = !NodeBuffer.isUtf8(bytes);
  const legacyEncoding = options.legacyEncoding ?? null;
  const decodable = options.truncated === true ? isUtf8Prefix(bytes) : !invalidUtf8;

  return {
    text:
      legacyEncoding !== null && !decodable
        ? decodeWithEncoding(bytes, legacyEncoding)
        : Buffer.from(bytes).toString("utf8"),
    invalidUtf8,
  };
};

interface CollectState {
  chunks: Uint8Array[];
  readonly bytes: number;
  readonly truncated: boolean;
}

export const collectUint8StreamText = <E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes?: number | undefined;
  readonly truncatedMarker?: string | null | undefined;
  readonly legacyEncoding?: string | null | undefined;
}): Effect.Effect<CollectedUint8StreamText, E> => {
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  const truncatedMarker = input.truncatedMarker ?? "";

  return input.stream.pipe(
    Stream.runFold(
      (): CollectState => ({
        chunks: [],
        bytes: 0,
        truncated: false,
      }),
      (state, chunk): CollectState => {
        // Keep draining after truncation; killing a child on Windows can invoke expensive taskkill.
        if (state.truncated) {
          return state;
        }

        const remainingBytes = maxBytes - state.bytes;
        if (remainingBytes <= 0) {
          return {
            ...state,
            truncated: true,
          };
        }

        const nextChunk =
          chunk.byteLength > remainingBytes ? chunk.slice(0, remainingBytes) : chunk;
        state.chunks.push(nextChunk);
        const bytes = state.bytes + nextChunk.byteLength;
        const truncated = chunk.byteLength > remainingBytes;

        return {
          chunks: state.chunks,
          bytes,
          truncated,
        };
      },
    ),
    Effect.map((state): CollectedUint8StreamText => {
      const decoded = decodeUtf8(Buffer.concat(state.chunks, state.bytes), {
        legacyEncoding: input.legacyEncoding,
        truncated: state.truncated,
      });
      return {
        text:
          state.truncated && truncatedMarker.length > 0
            ? `${decoded.text}${truncatedMarker}`
            : decoded.text,
        bytes: state.bytes,
        truncated: state.truncated,
        invalidUtf8: decoded.invalidUtf8,
      };
    }),
  );
};
