import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

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
      yield* Effect.logInfo(
        "abort fixture: constructor started",
        state.id.toString(),
      );
      const boots = ((yield* state.storage.get<number>("boots")) ?? 0) + 1;
      yield* state.storage.put("boots", boots);
      yield* Effect.logInfo("abort fixture: constructor completed", { boots });
      let failedPings = 0;
      return {
        ping: (fail = false) =>
          Effect.gen(function* () {
            yield* Effect.logInfo("abort fixture: ping", { boots, fail });
            if (fail) {
              failedPings++;
              return yield* Effect.die(
                new Error(
                  "internal error; reference = application-ping-failure",
                ),
              );
            }
            return { boots, failedPings, ok: true as const };
          }),
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
 * `GET /ping` reports constructor-run count. `GET /fail-ping` throws an
 * application error over native RPC without resetting the object. `GET /abort` invokes
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
    const describeError = (error: unknown) =>
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            ownProperties: Object.getOwnPropertyDescriptors(error),
            prototypeProperties: Object.getOwnPropertyNames(
              Object.getPrototypeOf(error),
            ),
          }
        : { value: String(error) };
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const task = tasks.getByName("default");

        if (url.pathname === "/ping" || url.pathname === "/fail-ping") {
          return yield* task.ping(url.pathname === "/fail-ping").pipe(
            Effect.flatMap((result) => HttpServerResponse.json(result)),
            Effect.catchCause((cause) => {
              const error = Cause.squash(cause);
              const native =
                error instanceof Cloudflare.RpcCallError
                  ? error.cause
                  : undefined;
              const methodUnavailable =
                native instanceof Error &&
                native.name === "TypeError" &&
                native.message ===
                  'The RPC receiver does not implement the method "ping".';
              const readinessRetry =
                url.pathname === "/ping" &&
                native instanceof Error &&
                !("overloaded" in native && native.overloaded === true) &&
                (("retryable" in native && native.retryable === true) ||
                  methodUnavailable ||
                  (native.name === "Error" &&
                    /^internal error; reference = \S+$/.test(native.message)));
              return HttpServerResponse.json(
                {
                  operation: "ping",
                  cause: Cause.pretty(cause),
                  native: describeError(native),
                  readinessRetry,
                },
                {
                  status: 500,
                  headers: {
                    "x-do-readiness-retry": String(readinessRetry),
                  },
                },
              );
            }),
          );
        }

        if (url.pathname === "/abort") {
          return yield* task.crash().pipe(
            Effect.matchCause({
              onFailure: (cause) => {
                const error = Cause.squash(cause);
                const aborted =
                  error instanceof Cloudflare.RpcCallError &&
                  error.cause instanceof Error &&
                  error.cause.message === "test abort";
                return HttpServerResponse.text(
                  `${aborted ? "aborted" : "unexpected abort failure"}: ${Cause.pretty(cause)}`,
                  { status: aborted ? 200 : 500 },
                );
              },
              onSuccess: () => HttpServerResponse.text("still-alive"),
            }),
          );
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}
