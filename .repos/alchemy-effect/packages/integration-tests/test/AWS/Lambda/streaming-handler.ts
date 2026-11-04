import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";

export class StreamingFunction extends Lambda.Function<Lambda.Function>()("StreamingFunction") {}

export default StreamingFunction.make(
  {
    main: import.meta.url,
    functionUrl: { invokeMode: "RESPONSE_STREAM" },
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    return {
      // Each event is held back two seconds, so a buffered response would
      // deliver all three at once.
      fetch: Effect.succeed(
        HttpServerResponse.stream(
          Stream.make("data: one\n\n", "data: two\n\n", "data: three\n\n").pipe(
            Stream.tap(() => Effect.sleep("2 seconds")),
            Stream.encodeText,
          ),
          {
            contentType: "text/event-stream",
            headers: { "x-streamed": "true" },
          },
        ).pipe(HttpServerResponse.setCookieUnsafe("session", "abc")),
      ),
    };
  }),
);
