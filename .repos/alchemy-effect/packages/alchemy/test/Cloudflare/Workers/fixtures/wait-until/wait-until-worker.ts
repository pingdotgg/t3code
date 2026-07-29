import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Durable Object journal for `WaitUntil.test.ts`.
 *
 * `record` persists an entry inline. `recordLater` returns before persisting
 * and uses `DurableObjectState.waitUntil` to write the entry in the
 * background — the test only sees the entry if waitUntil actually kept the
 * DO alive past the RPC response.
 */
export class Journal extends Cloudflare.DurableObject<Journal>()(
  "Journal",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const append = Effect.fn(function* (entry: string) {
        const entries = (yield* state.storage.get<string[]>("entries")) ?? [];
        yield* state.storage.put("entries", [...entries, entry]);
      });
      return {
        record: append,
        recordLater: Effect.fn(function* (entry: string) {
          yield* state.waitUntil(
            Effect.sleep("100 millis").pipe(Effect.andThen(append(entry))),
          );
          return "scheduled" as const;
        }),
        // Scope finalizers added inside a DO method run after the method
        // returns: the bridge closes the per-call scope and registers the
        // close promise with `state.waitUntil`.
        recordOnClose: Effect.fn(function* (entry: string) {
          yield* Effect.addFinalizer(() =>
            Effect.sleep("100 millis").pipe(
              Effect.andThen(append(entry)),
              Effect.ignore,
            ),
          );
          return "scheduled" as const;
        }),
        snapshot: Effect.fn(function* () {
          return {
            entries: (yield* state.storage.get<string[]>("entries")) ?? [],
          };
        }),
      };
    });
  }),
) {}

/**
 * Fixture worker for `WaitUntil.test.ts`.
 *
 * `GET /bg` responds immediately and records a journal entry from a
 * background Effect via `WorkerExecutionContext.waitUntil`. `GET /bg-do`
 * exercises `DurableObjectState.waitUntil` inside the DO. The test polls
 * `GET /entries` until both entries appear.
 */
export default class WaitUntilWorker extends Cloudflare.Worker<WaitUntilWorker>()(
  "WaitUntilWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const journals = yield* Journal;
    // Yielded from the init closure (deferred instance) — its methods
    // resolve the live per-event context when invoked inside a handler.
    const exec = yield* Cloudflare.WorkerExecutionContext;
    // Probes: observe how often the init closure itself runs and if/when a
    // finalizer added in the init closure runs. Counted on globalThis and
    // exposed via /init-runs and /init-finalizer-runs.
    yield* Effect.sync(() => {
      (globalThis as any).__initRuns =
        ((globalThis as any).__initRuns ?? 0) + 1;
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        (globalThis as any).__initFinalizerRuns =
          ((globalThis as any).__initFinalizerRuns ?? 0) + 1;
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const journal = journals.getByName("default");

        if (url.pathname === "/bg") {
          yield* exec.waitUntil(
            Effect.sleep("100 millis").pipe(
              Effect.andThen(journal.record("from-worker-wait-until")),
            ),
          );
          return HttpServerResponse.text("bg-scheduled");
        }

        if (url.pathname === "/bg-do") {
          return HttpServerResponse.text(
            `bg-do-${yield* journal.recordLater("from-do-wait-until")}`,
          );
        }

        // Scope finalizers added in a fetch handler run after the response
        // is sent: the bridge closes the request scope and registers the
        // close promise with `ctx.waitUntil`.
        if (url.pathname === "/finalizer") {
          yield* Effect.addFinalizer(() =>
            Effect.sleep("100 millis").pipe(
              Effect.andThen(journal.record("from-request-finalizer")),
              Effect.ignore,
            ),
          );
          return HttpServerResponse.text("finalizer-scheduled");
        }

        if (url.pathname === "/finalizer-do") {
          return HttpServerResponse.text(
            `do-finalizer-${yield* journal.recordOnClose("from-do-finalizer")}`,
          );
        }

        if (url.pathname === "/entries") {
          return yield* HttpServerResponse.json(yield* journal.snapshot());
        }

        if (url.pathname === "/init-finalizer-runs") {
          return HttpServerResponse.text(
            String((globalThis as any).__initFinalizerRuns ?? 0),
          );
        }

        if (url.pathname === "/init-runs") {
          return HttpServerResponse.text(
            String((globalThis as any).__initRuns ?? 0),
          );
        }

        if (url.pathname === "/raw") {
          const exec = yield* Cloudflare.WorkerExecutionContext;
          return HttpServerResponse.text(
            typeof exec.raw.waitUntil === "function" ? "ok" : "missing",
          );
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}
