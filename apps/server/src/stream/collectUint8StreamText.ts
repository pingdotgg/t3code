import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface CollectedUint8StreamText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

interface CollectState {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export const collectUint8StreamText = <E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes?: number | undefined;
  readonly truncatedMarker?: string | null | undefined;
}): Effect.Effect<CollectedUint8StreamText, E> => {
  const decoder = new TextDecoder();
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  const truncatedMarker = input.truncatedMarker ?? "";

  return input.stream.pipe(
    Stream.runFold(
      (): CollectState => ({
        text: "",
        bytes: 0,
        truncated: false,
      }),
      (state, chunk): CollectState => {
        if (state.truncated) {
          return state;
        }

        const remainingBytes = maxBytes - state.bytes;
        if (remainingBytes <= 0) {
          return {
            ...state,
            text: `${state.text}${truncatedMarker}`,
            truncated: true,
          };
        }

        const nextChunk =
          chunk.byteLength > remainingBytes ? chunk.slice(0, remainingBytes) : chunk;
        const text = `${state.text}${decoder.decode(nextChunk, { stream: true })}`;
        const bytes = state.bytes + nextChunk.byteLength;
        const truncated = chunk.byteLength > remainingBytes;

        return {
          text: truncated ? `${text}${truncatedMarker}` : text,
          bytes,
          truncated,
        };
      },
    ),
    Effect.map(
      (state): CollectedUint8StreamText => ({
        text: state.truncated ? state.text : `${state.text}${decoder.decode()}`,
        bytes: state.bytes,
        truncated: state.truncated,
      }),
    ),
  );
};
