import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServerResponse } from "effect/http";

// Cloudflare closes idle streams after about 100 seconds.
const HEARTBEAT_INTERVAL = Duration.seconds(20);

/** Server-sent events with a heartbeat, never cached or buffered on the way. */
export const eventStreamResponse = <A>(
  events: Stream.Stream<A>,
  encode: (event: A) => Effect.Effect<string, Schema.SchemaError>,
) => {
  const data = events.pipe(
    Stream.mapEffect((event) =>
      encode(event).pipe(
        Effect.map((json) => [`data: ${json}\n\n`]),
        // The reader misses one update instead of the whole stream.
        Effect.catch(() =>
          Effect.logWarning("Dropped a stream event that failed to encode.").pipe(Effect.as([])),
        ),
      ),
    ),
    Stream.flattenIterable,
  );
  const heartbeat = Stream.tick(HEARTBEAT_INTERVAL).pipe(Stream.map(() => ": ping\n\n"));
  return HttpServerResponse.stream(
    data.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
    {
      contentType: "text/event-stream",
      // no-transform keeps the compression middleware from buffering the stream.
      headers: { "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
    },
  );
};
