import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export type RelayHttpResponseBodyEvent =
  | { readonly type: "chunk"; readonly bytes: Uint8Array }
  | { readonly type: "end" }
  | { readonly type: "abort"; readonly reason: string };

export function relayHttpResponseBodyStream(
  queue: Queue.Queue<RelayHttpResponseBodyEvent>,
): Stream.Stream<Uint8Array> {
  return Stream.fromQueue(queue).pipe(
    Stream.takeWhile((event) => event.type !== "end"),
    Stream.mapEffect((event) =>
      event.type === "chunk"
        ? Effect.succeed(event.bytes)
        : Effect.die(new Error(`Relay HTTP response aborted: ${event.reason}`)),
    ),
  );
}
