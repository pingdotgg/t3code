import * as Lambda from "@/AWS/Lambda";
import * as Logs from "@/AWS/Logs";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "sink-handler.ts");

export const SINK_STREAM_NAME = "alchemy-test-log-event-sink-stream";

export class LogEventSinkFunction extends Lambda.Function<Lambda.Function>()(
  "LogEventSinkFunction",
) {}

export default LogEventSinkFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const logGroup = yield* Logs.LogGroup("SinkLogGroup", {
      retention: "1 day",
    });
    yield* Logs.LogStream("SinkLogStream", {
      logGroupName: logGroup.logGroupName,
      logStreamName: SINK_STREAM_NAME,
    });

    const sink = yield* Logs.LogEventSink(logGroup, {
      logStreamName: SINK_STREAM_NAME,
    });
    const LogGroupName = yield* logGroup.logGroupName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({
            ok: true,
            logGroupName: yield* LogGroupName,
            logStreamName: SINK_STREAM_NAME,
          });
        }

        if (request.method === "POST" && pathname === "/sink") {
          const body = (yield* request.json) as { messages: string[] };
          const start = yield* Clock.currentTimeMillis;
          // PutLogEvents requires chronological order within a batch —
          // ordering stays with the caller, so stamp increasing timestamps.
          const events = body.messages.map((message, index) => ({
            timestamp: start + index,
            message,
          }));

          yield* Stream.fromIterable(events).pipe(Stream.run(sink));

          return yield* HttpServerResponse.json({
            ok: true,
            count: body.messages.length,
          });
        }

        if (request.method === "POST" && pathname === "/sink-with-rejected") {
          const body = (yield* request.json) as {
            valid: string[];
            rejected: string;
          };
          const now = yield* Clock.currentTimeMillis;
          // Valid events now, then one event 3 hours in the future — more
          // than the 2-hour PutLogEvents window, so the API permanently
          // rejects it (rejectedLogEventsInfo.tooNewLogEventStartIndex)
          // while still ingesting the valid events. The sink must drop the
          // rejected event (no retry) and complete successfully.
          const events = [
            ...body.valid.map((message, index) => ({
              timestamp: now + index,
              message,
            })),
            {
              timestamp: now + 3 * 60 * 60 * 1000,
              message: body.rejected,
            },
          ];

          yield* Stream.fromIterable(events).pipe(Stream.run(sink));

          return yield* HttpServerResponse.json({
            ok: true,
            count: events.length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(Logs.LogEventSinkHttp, Logs.PutLogEventsHttp),
    ),
  ),
);
