import type { PostHogCloudStreamEvent } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

interface SseFrameState {
  readonly event: string;
  readonly id?: string;
  readonly data: ReadonlyArray<string>;
}

const emptyFrame = (): SseFrameState => ({ event: "message", data: [] });

function finishFrame(state: SseFrameState): ReadonlyArray<PostHogCloudStreamEvent> {
  if (state.data.length === 0) return [];
  const text = state.data.join("\n");
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return [
    {
      event: state.event,
      ...(state.id !== undefined ? { id: state.id } : {}),
      data,
    },
  ];
}

export function decodePostHogSse<E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<PostHogCloudStreamEvent, E, R> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapAccum(
      emptyFrame,
      (state, line): readonly [SseFrameState, ReadonlyArray<PostHogCloudStreamEvent>] => {
        if (line === "") return [emptyFrame(), finishFrame(state)];
        if (line.startsWith(":")) return [state, []];
        const separator = line.indexOf(":");
        const field = separator === -1 ? line : line.slice(0, separator);
        const rawValue = separator === -1 ? "" : line.slice(separator + 1);
        const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
        if (field === "event") return [{ ...state, event: value || "message" }, []];
        if (field === "id") return [{ ...state, id: value }, []];
        if (field === "data") return [{ ...state, data: [...state.data, value] }, []];
        return [state, []];
      },
      { onHalt: finishFrame },
    ),
  );
}
