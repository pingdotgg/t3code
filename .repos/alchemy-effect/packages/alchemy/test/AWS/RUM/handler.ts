import * as Lambda from "@/AWS/Lambda";
import * as RUM from "@/AWS/RUM";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class RumBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "RumBindingsFunction",
) {}

export default RumBindingsFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    const monitor = yield* RUM.AppMonitor("BindingsMonitor", {
      domain: "example.com",
      appMonitorConfiguration: {
        sessionSampleRate: 1,
        telemetries: ["errors", "performance"],
      },
    });

    const bound = {
      putRumEvents: yield* RUM.PutRumEvents(monitor),
      getAppMonitorData: yield* RUM.GetAppMonitorData(monitor),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Data plane: send one synthetic session's events (the same call the
        // RUM web client makes) — the monitor id and AppMonitorDetails are
        // injected by the binding. A typed failure reports its tag so a
        // grant gap is diagnosable from the JSON.
        if (request.method === "POST" && pathname === "/events") {
          const ids = yield* Effect.sync(() => ({
            batch: crypto.randomUUID(),
            event: crypto.randomUUID(),
            session: crypto.randomUUID(),
            user: crypto.randomUUID(),
          }));
          const result = yield* Effect.result(
            bound.putRumEvents({
              BatchId: ids.batch,
              UserDetails: { userId: ids.user, sessionId: ids.session },
              RumEvents: [
                {
                  id: ids.event,
                  timestamp: new Date(),
                  type: "com.amazon.rum.session_start_event",
                  details: "{}",
                },
              ],
            }),
          );
          return yield* HttpServerResponse.json(
            Result.isSuccess(result)
              ? { tag: "ok" }
              : { tag: result.failure._tag, error: String(result.failure) },
          );
        }

        // Read the trailing hour of collected events back out of the monitor.
        if (request.method === "GET" && pathname === "/data") {
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* Effect.result(
            bound.getAppMonitorData({
              TimeRange: { After: now - 3_600_000, Before: now },
            }),
          );
          return yield* HttpServerResponse.json(
            Result.isSuccess(result)
              ? { tag: "ok", count: (result.success.Events ?? []).length }
              : { tag: result.failure._tag, error: String(result.failure) },
          );
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(RUM.PutRumEventsHttp, RUM.GetAppMonitorDataHttp),
    ),
  ),
);
