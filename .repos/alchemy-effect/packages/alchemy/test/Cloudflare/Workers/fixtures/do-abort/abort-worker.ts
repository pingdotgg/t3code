import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Durable Object for `DurableObjectAbort.test.ts`.
 *
 * Construction increments a persistent `boots` counter. `crash` calls
 * `state.abort` with `{ retryAlarm: false }` so the isolate resets and
 * the next request reconstructs (boots + 1).
 */
export class Task extends Cloudflare.DurableObject<Task>()(
  "Task",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const boots = ((yield* state.storage.get<number>("boots")) ?? 0) + 1;
      yield* state.storage.put("boots", boots);
      return {
        ping: () => Effect.succeed({ boots, ok: true as const }),
        crash: () =>
          Effect.gen(function* () {
            yield* state.abort("test abort", { retryAlarm: false });
          }),
      };
    });
  }),
) {}

/**
 * Fixture worker for `DurableObjectAbort.test.ts`.
 *
 * `GET /ping` reports constructor-run count. `GET /abort` invokes
 * `state.abort` on the DO (the RPC fails because the isolate is reset)
 * and returns `"aborted"`.
 */
export default class AbortWorker extends Cloudflare.Worker<AbortWorker>()(
  "AbortWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const tasks = yield* Task;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const task = tasks.getByName("default");

        if (url.pathname === "/ping") {
          return yield* HttpServerResponse.json(yield* task.ping());
        }

        if (url.pathname === "/abort") {
          return yield* task.crash().pipe(
            Effect.matchCause({
              onFailure: () => HttpServerResponse.text("aborted"),
              onSuccess: () => HttpServerResponse.text("still-alive"),
            }),
          );
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}
