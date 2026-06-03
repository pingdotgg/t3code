import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Durable Object that records each `scheduledTime` the cron handler sees.
 * The test polls `snapshot()` via the worker's `GET /times` route to verify
 * the cron actually fired.
 */
export class CronCounter extends Cloudflare.DurableObjectNamespace<CronCounter>()(
  "CronCounter",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      let times = (yield* state.storage.get<number[]>("times")) ?? [];
      return {
        record: Effect.fn(function* (time: number) {
          times = [...times, time];
          yield* state.storage.put("times", times);
        }),
        snapshot: () => Effect.succeed({ times }),
        reset: Effect.fn(function* () {
          times = [];
          yield* state.storage.put("times", times);
        }),
      };
    });
  }),
) {}

/**
 * Fixture worker for `CronEventSource.test.ts`.
 *
 * Cloudflare's minimum cron granularity is one minute, so the trigger is set
 * to `* * * * *`. Each fire records `controller.scheduledTime` on the
 * `CronCounter` DO. The test polls `GET /times` until at least one entry
 * appears (or the timeout expires).
 */
export default class CronTestWorker extends Cloudflare.Worker<CronTestWorker>()(
  "CronTestWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const counters = yield* CronCounter;

    yield* Cloudflare.cron("* * * * *").subscribe((controller) =>
      counters.getByName("default").record(controller.scheduledTime),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "GET" && url.pathname === "/times") {
          const snapshot = yield* counters.getByName("default").snapshot();
          return yield* HttpServerResponse.json(snapshot);
        }

        if (request.method === "POST" && url.pathname === "/reset") {
          yield* counters.getByName("default").reset();
          return yield* HttpServerResponse.json({ ok: true });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.CronEventSourceLive)),
) {}
