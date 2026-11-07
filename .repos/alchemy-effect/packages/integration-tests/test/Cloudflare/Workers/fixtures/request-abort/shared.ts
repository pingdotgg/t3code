import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** Records what each request's handler did, so the test can read it afterwards. */
export class Journal extends Cloudflare.DurableObject<Journal>()(
  "Journal",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.succeed({
      record: (id: string, event: string) =>
        Effect.gen(function* () {
          const events = (yield* state.storage.get<string[]>(id)) ?? [];
          yield* state.storage.put(id, [...events, event]);
        }),
      events: (id: string) => state.storage.get<string[]>(id),
    });
  }),
) {}

/**
 * The Worker body: `/slow` records `started`, sleeps past the test, and
 * records how its release ran.
 */
export const requestAbortHandler = Effect.gen(function* () {
  const journals = yield* Journal;
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = yield* Effect.sync(() => new URL(request.url, "https://worker.test"));
      const id = url.searchParams.get("id") ?? "default";
      const journal = journals.getByName("requests");
      if (url.pathname === "/ready") {
        yield* journal.events("ready");
        return HttpServerResponse.text("request-abort:ready");
      }
      if (url.pathname === "/events") {
        return yield* HttpServerResponse.json((yield* journal.events(id)) ?? []);
      }
      // A slow provider call that outlasts the test. (A handler that waits
      // on nothing at all is cancelled by workerd as hung.)
      return yield* Effect.acquireUseRelease(
        journal.record(id, "started"),
        () => Effect.sleep("2 minutes"),
        (_, exit) =>
          journal
            .record(
              id,
              Exit.isSuccess(exit)
                ? "released:success"
                : Cause.hasInterruptsOnly(exit.cause)
                  ? "released:interrupt"
                  : "released:failure",
            )
            .pipe(Effect.orDie),
      ).pipe(Effect.as(HttpServerResponse.text("done")));
    }),
  };
});
