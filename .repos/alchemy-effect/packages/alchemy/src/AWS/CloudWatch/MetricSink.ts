import type * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { BatchRetryExhaustedError } from "../internal/BatchedSink.ts";

/**
 * A raw `MetricDatum` as accepted by `PutMetricData`. Callers stay in control
 * of `MetricName`, `Dimensions`, `Timestamp`, `Value`/`Values`/`Counts`,
 * `StatisticValues`, `Unit` and `StorageResolution` — no auto-marshalling.
 */
export type MetricSinkDatum = cloudwatch.MetricDatum;

export interface MetricSinkProps {
  /**
   * The CloudWatch namespace every datum is published under
   * (e.g. `"MyApp/Payments"`). Must not start with `AWS/`.
   */
  readonly Namespace: string;
}

export type MetricSinkError =
  | cloudwatch.PutMetricDataError
  | BatchRetryExhaustedError<MetricSinkDatum>;

/**
 * A batching sink over CloudWatch `PutMetricData` (1000 datums / ~1 MB per
 * call). Each upstream chunk is greedily packed into order-preserving
 * batches and sent sequentially.
 *
 * `PutMetricData` is all-or-nothing: there are no per-datum partial
 * failures, so a failed call surfaces directly on the sink's error channel
 * as the typed `PutMetricDataError` union.
 *
 * Provide `CloudWatch.MetricSinkHttp` (which itself needs
 * `CloudWatch.PutMetricDataHttp`) on the hosting Lambda Function:
 * `Effect.provide(Layer.provideMerge(AWS.CloudWatch.MetricSinkHttp, AWS.CloudWatch.PutMetricDataHttp))`.
 *
 * @binding
 * @section Streaming Metrics
 * @example Stream Datums into CloudWatch
 * ```typescript
 * // init — grants cloudwatch:PutMetricData; all datums publish under Namespace
 * const sink = yield* AWS.CloudWatch.MetricSink({
 *   Namespace: "MyApp/Payments",
 * });
 *
 * // runtime — datums are packed into 1000-datum PutMetricData batches
 * yield* Stream.fromIterable(
 *   payments.map((payment) => ({
 *     MetricName: "PaymentProcessed",
 *     Dimensions: [{ Name: "Region", Value: payment.region }],
 *     Value: payment.amount,
 *     Unit: "Count",
 *   }) satisfies AWS.CloudWatch.MetricSinkDatum),
 * ).pipe(Stream.run(sink));
 * ```
 */
export interface MetricSink extends Binding.Service<
  MetricSink,
  "AWS.CloudWatch.MetricSink",
  (
    props: MetricSinkProps,
  ) => Effect.Effect<
    Sink.Sink<
      void,
      MetricSinkDatum,
      readonly MetricSinkDatum[],
      MetricSinkError
    >
  >
> {}

export const MetricSink = Binding.Service<MetricSink>(
  "AWS.CloudWatch.MetricSink",
);
