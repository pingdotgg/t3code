import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Ride out the window in which a Worker created earlier in the same apply is
 * not yet visible to Email Routing's action validation.
 *
 * Cloudflare validates a `{ type: "worker", value: [scriptName] }` action
 * while handling the create/update request and rejects it with
 * `WorkerScriptNotFound` ("Workers Script Info not found") until the script
 * propagates — typically within a few hundred milliseconds. The rejected call
 * creates nothing, so a retry cannot produce a duplicate rule.
 *
 * Mirrors `Cloudflare/Fetcher`'s treatment of a freshly-deployed script:
 * bounded exponential backoff (~25s total), then re-raise the original error
 * unchanged so a genuinely missing Worker still fails and says so.
 *
 * @see https://github.com/alchemy-run/alchemy/issues/1348
 */
export const retryWorkerScriptNotFound = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "WorkerScriptNotFound",
      schedule: Schedule.exponential("100 millis"),
      times: 8,
    }),
  );
