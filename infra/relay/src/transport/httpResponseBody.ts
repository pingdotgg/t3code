import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export type RelayHttpResponseBodyEvent =
  | { readonly type: "chunk"; readonly bytes: Uint8Array }
  | { readonly type: "end" }
  | { readonly type: "abort"; readonly reason: string };

/**
 * An in-flight HTTP response keeps the Durable Object awake and billed. A
 * slow client is fine because it keeps consuming chunks, but a client that
 * stops reading stalls the body on flow control forever. The guard bounds the
 * time between chunks handed to the client, not the total download, so a large
 * file on a slow link still completes while an abandoned one is released.
 */
export const RELAY_HTTP_RESPONSE_IDLE_TIMEOUT: Duration.Input = "60 seconds";

/**
 * Turns the connector's body events into a byte stream. Each chunk records
 * progress for the idle watchdog. The stream itself cannot detect a stalled
 * consumer, because the runtime stops pulling it under backpressure and no
 * operator runs while nothing pulls. Pair it with `relayHttpResponseIdleWatchdog`.
 */
export function relayHttpResponseBodyStream(
  queue: Queue.Queue<RelayHttpResponseBodyEvent>,
  progress?: { lastChunkAt: number },
): Stream.Stream<Uint8Array> {
  return Stream.fromQueue(queue).pipe(
    Stream.takeWhile((event) => event.type !== "end"),
    Stream.mapEffect((event) =>
      event.type === "chunk"
        ? progress === undefined
          ? Effect.succeed(event.bytes)
          : Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                progress.lastChunkAt = now;
                return event.bytes;
              }),
            )
        : Effect.die(new Error(`Relay HTTP response aborted: ${event.reason}`)),
    ),
  );
}

/**
 * Sleeps until no chunk has been handed to the client for `idleTimeout`,
 * then resolves. Run it on its own fiber, independent of the body stream, and
 * shut the body queue when it resolves so the stalled consumer fails the next
 * time it pulls. Returns immediately if `progress` never advances.
 */
export function relayHttpResponseIdleWatchdog(
  progress: { readonly lastChunkAt: number },
  idleTimeout: Duration.Input = RELAY_HTTP_RESPONSE_IDLE_TIMEOUT,
): Effect.Effect<void> {
  const idleMillis = Duration.toMillis(idleTimeout);
  return Effect.gen(function* () {
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      const remaining = idleMillis - (now - progress.lastChunkAt);
      if (remaining <= 0) return;
      yield* Effect.sleep(Duration.millis(remaining));
    }
  });
}
