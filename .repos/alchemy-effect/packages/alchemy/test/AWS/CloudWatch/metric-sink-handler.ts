import * as AWS from "@/AWS";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "metric-sink-handler.ts");

/**
 * Namespace + metric the sink fixture publishes under. The test isolates
 * runs from each other with a unique `Run` dimension value per invocation.
 */
export const SINK_NAMESPACE = "Alchemy/MetricSinkTest";
export const SINK_METRIC_NAME = "MetricSinkTestMetric";

export class MetricSinkFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "MetricSinkFunction",
) {}

export const MetricSinkFunctionLive = MetricSinkFunction.make(
  {
    main,
    url: true,
    // Streaming >1000 datums makes 2 sequential PutMetricData calls; give
    // cold starts + both calls comfortable headroom over Lambda's 3s default.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const sink = yield* AWS.CloudWatch.MetricSink({
      Namespace: SINK_NAMESPACE,
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/sink") {
          const body = (yield* request.json) as {
            runId: string;
            count: number;
          };

          // Raw MetricDatum entries — the caller owns the shape; the sink
          // only packs/batches. >1000 datums forces a 1000 + remainder split.
          yield* Stream.fromIterable(
            Array.from(
              { length: body.count },
              () =>
                ({
                  MetricName: SINK_METRIC_NAME,
                  Dimensions: [{ Name: "Run", Value: body.runId }],
                  Value: 1,
                  Unit: "Count",
                }) satisfies AWS.CloudWatch.MetricSinkDatum,
            ),
          ).pipe(Stream.run(sink));

          return yield* HttpServerResponse.json({
            ok: true,
            count: body.count,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        Effect.tapError(Console.log),
        Effect.catch((error) =>
          Effect.succeed(
            HttpServerResponse.text(`Internal server error: ${String(error)}`, {
              status: 500,
            }),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        AWS.CloudWatch.MetricSinkHttp,
        AWS.CloudWatch.PutMetricDataHttp,
      ),
    ),
  ),
);
export default MetricSinkFunctionLive;
