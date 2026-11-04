import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";

/**
 * Private Effect-native Cloud Run Service (invoker IAM enforced).
 * Called by {@link ./invoke-caller.ts} from {@link ../InvokeService.test.ts}.
 */
export default class InvokeCallee extends GCP.Function<InvokeCallee>()(
  "InvokeCallee",
  {
    main: import.meta.url,
    location: "us-central1",
  },
  Effect.gen(function* () {
    return {
      // Served on `/__rpc__/*` behind Cloud Run's IAM invoker check.
      add: (a: number, b: number) => Effect.succeed(a + b),
      countdown: (from: number) => Stream.range(1, from).pipe(Stream.map((n) => from - n + 1)),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const body = request.method === "POST" ? yield* request.text : "";
        return yield* HttpServerResponse.json({
          from: "callee",
          method: request.method,
          path: new URL(request.originalUrl, "http://localhost").pathname,
          body,
        });
      }),
    };
  }),
) {}
