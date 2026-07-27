import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  MetricSinkFunction,
  MetricSinkFunctionLive,
  SINK_METRIC_NAME,
  SINK_NAMESPACE,
} from "./metric-sink-handler";

const { test } = Test.make({ providers: AWS.providers() });

class FunctionNotReady extends Data.TaggedError("FunctionNotReady") {}

class MetricsNotVisible extends Data.TaggedError("MetricsNotVisible")<{
  readonly observed: number;
  readonly expected: number;
}> {}

const waitForFunctionReady = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.void
        : Effect.fail(new FunctionNotReady()),
    ),
    Effect.retry({
      while: (error) => error._tag === "FunctionNotReady",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(75),
      ]),
    }),
  );

/**
 * Out-of-band verification: poll GetMetricStatistics until the summed
 * `Sum` across datapoints for the run's unique dimension reaches the
 * published total. Standard-resolution data is typically queryable within
 * seconds to ~2 minutes of PutMetricData; the poll is bounded at ~3 min.
 */
const waitForMetricSum = Effect.fn(function* (
  runId: string,
  expected: number,
  startTime: Date,
) {
  return yield* Effect.gen(function* () {
    const stats = yield* cloudwatch.getMetricStatistics({
      Namespace: SINK_NAMESPACE,
      MetricName: SINK_METRIC_NAME,
      Dimensions: [{ Name: "Run", Value: runId }],
      StartTime: startTime,
      EndTime: new Date(Date.now() + 60_000),
      Period: 60,
      Statistics: ["Sum", "SampleCount"],
    });
    const observed = (stats.Datapoints ?? []).reduce(
      (total, point) => total + (point.Sum ?? 0),
      0,
    );
    if (observed < expected) {
      return yield* Effect.fail(new MetricsNotVisible({ observed, expected }));
    }
    return observed;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "MetricsNotVisible",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(36),
      ]),
    }),
  );
});

test.provider(
  "MetricSink batches >1000 datums through a deployed Lambda",
  (stack) =>
    Effect.gen(function* () {
      // Leading destroy reconciles away any prior partial/crashed deployment.
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        MetricSinkFunction.pipe(Effect.provide(MetricSinkFunctionLive)),
      );
      const baseUrl = fn.functionUrl!.replace(/\/+$/, "");

      yield* waitForFunctionReady(`${baseUrl}/ready`);

      // 1500 datums > the PutMetricData limit of 1000 per call, so the
      // batched sink must split the stream into 2 sequential API calls
      // (1000 + 500). PutMetricData is all-or-nothing, so Sum === 1500
      // proves both calls landed.
      const runId = crypto.randomUUID();
      const count = 1500;
      const startTime = new Date(Date.now() - 5 * 60_000);

      const response = yield* HttpClient.post(`${baseUrl}/sink`, {
        body: yield* HttpBody.json({ runId, count }),
      }).pipe(
        Effect.flatMap((result) =>
          result.status === 200
            ? Effect.succeed(result)
            : Effect.fail("not ready"),
        ),
        // Fresh function URLs can serve transient non-200s while IAM and
        // DNS propagate — retry only that window.
        Effect.retry({
          while: (error) => error === "not ready",
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(30),
          ]),
        }),
        Effect.flatMap((result) => result.json),
      );

      expect((response as any).ok).toBe(true);
      expect((response as any).count).toBe(count);

      const observed = yield* waitForMetricSum(runId, count, startTime);
      expect(observed).toBe(count);

      yield* stack.destroy();

      // Out-of-band assert-gone: the deployed Lambda no longer exists after
      // the final destroy (custom metrics themselves are not deletable and
      // age out on their own).
      const gone = yield* lambda
        .getFunction({ FunctionName: fn.functionName })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
    }),
  // Deploy (~60-120s) + readiness poll (bounded ~150s) + metric visibility
  // poll (bounded ~180s) + destroy. All waits are bounded.
  { timeout: 420_000 },
);
