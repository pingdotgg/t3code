import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as NodeBuffer from "node:buffer";

export interface CollectedUint8StreamText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
  readonly invalidUtf8: boolean;
}

export const decodeUtf8 = (
  bytes: Uint8Array,
): Pick<CollectedUint8StreamText, "text" | "invalidUtf8"> => ({
  text: Buffer.from(bytes).toString("utf8"),
  invalidUtf8: !NodeBuffer.isUtf8(bytes),
});

interface CollectState {
  chunks: Uint8Array[];
  readonly bytes: number;
  readonly truncated: boolean;
}

export const collectUint8StreamText = <E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes?: number | undefined;
  readonly truncatedMarker?: string | null | undefined;
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
        /*
         * keep draining after truncation so the child process can exit normally.
         * its a know issue that on windows killing after the output cap can force an expensive taskkill operation and hurt performance
         */
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
      const decoded = decodeUtf8(Buffer.concat(state.chunks, state.bytes));
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
