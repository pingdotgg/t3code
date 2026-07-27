import * as AWS from "@/AWS/index.ts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Probe for Lambda's Shutdown phase.
 *
 * The init closure registers an instance-scope finalizer that writes a
 * marker to stdout (→ CloudWatch): the generated entry registers an
 * internal extension, so Lambda grants the runtime a 500 ms SIGTERM window
 * at sandbox spin-down in which the entry closes the instance scope — the
 * marker appears exactly once per sandbox, never per invocation.
 *
 * The fetch handler registers a request-scope finalizer whose marker must
 * appear once per invocation (the dispatch settles the request scope
 * inline before returning).
 */
export default class ShutdownProbe extends AWS.Lambda.Function<ShutdownProbe>()(
  "ShutdownProbe",
  {
    main: import.meta.url,
    url: true,
    timeout: Duration.seconds(10),
  },
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => console.log("ALCHEMY_INSTANCE_FINALIZED")),
    );
    return {
      fetch: Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => console.log("ALCHEMY_REQUEST_FINALIZED")),
        );
        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
