import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Worker without `dev.access`: under `alchemy dev`, `ctx.access` is
 * `undefined`, simulating an unauthenticated request.
 */
export default class AnonAccessWorker extends Cloudflare.Worker<AnonAccessWorker>()(
  "AnonAccessWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        // The one-yield accessor (vs. authed-worker.ts, which pins the
        // `WorkerExecutionContext.access` surface).
        const access = yield* Cloudflare.Access.Context;
        return yield* HttpServerResponse.json({
          authenticated: access !== undefined,
        });
      }),
    };
  }),
) {}
