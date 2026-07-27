import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MetricStream } from "./MetricStream.ts";

type MetricStreams = [MetricStream, ...MetricStream[]];

/**
 * Runtime binding for `cloudwatch:StopMetricStreams` — pause streaming for
 * the bound metric streams (e.g. to control Firehose cost during an
 * incident). Resume with {@link StartMetricStreams}. Bind it to one or more
 * {@link MetricStream} resources; the stream names are injected
 * automatically.
 *
 * Provide `CloudWatch.StopMetricStreamsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Managing Metric Streams
 * @example Pause a Metric Stream
 * ```typescript
 * // init — grants cloudwatch:StopMetricStreams on the stream
 * const stopMetricStreams = yield* AWS.CloudWatch.StopMetricStreams(stream);
 *
 * // runtime
 * yield* stopMetricStreams();
 * ```
 */
export interface StopMetricStreams extends Binding.Service<
  StopMetricStreams,
  "AWS.CloudWatch.StopMetricStreams",
  (
    ...streams: MetricStreams
  ) => Effect.Effect<
    () => Effect.Effect<cloudwatch.StopMetricStreamsOutput, any>
  >
> {}

export const StopMetricStreams = Binding.Service<StopMetricStreams>(
  "AWS.CloudWatch.StopMetricStreams",
);
