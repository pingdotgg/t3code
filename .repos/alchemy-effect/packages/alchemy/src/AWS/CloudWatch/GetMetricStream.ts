import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MetricStream } from "./MetricStream.ts";

export interface GetMetricStreamRequest extends Omit<
  cloudwatch.GetMetricStreamInput,
  "Name"
> {}

/**
 * Runtime binding for `cloudwatch:GetMetricStream` — read the
 * configuration and state of the bound {@link MetricStream}; the stream
 * name is injected automatically.
 *
 * Provide `CloudWatch.GetMetricStreamHttp` on the hosting Lambda Function
 * to satisfy the requirement.
 * @binding
 * @section Reading Metric Streams
 * @example Read a Bound Metric Stream
 * ```typescript
 * // init — grants cloudwatch:GetMetricStream on the stream
 * const getMetricStream = yield* AWS.CloudWatch.GetMetricStream(metricStream);
 *
 * // runtime
 * const result = yield* getMetricStream();
 * const state = result.State; // "running" | "stopped"
 * ```
 */
export interface GetMetricStream extends Binding.Service<
  GetMetricStream,
  "AWS.CloudWatch.GetMetricStream",
  (
    metricStream: MetricStream,
  ) => Effect.Effect<
    (
      request?: GetMetricStreamRequest,
    ) => Effect.Effect<
      cloudwatch.GetMetricStreamOutput,
      cloudwatch.GetMetricStreamError
    >
  >
> {}

export const GetMetricStream = Binding.Service<GetMetricStream>(
  "AWS.CloudWatch.GetMetricStream",
);
