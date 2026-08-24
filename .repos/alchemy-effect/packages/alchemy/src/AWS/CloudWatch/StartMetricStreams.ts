import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MetricStream } from "./MetricStream.ts";

type MetricStreams = [MetricStream, ...MetricStream[]];

/**
 * Runtime binding for `cloudwatch:StartMetricStreams` — resume streaming
 * for the bound metric streams after they were paused with
 * {@link StopMetricStreams}. Bind it to one or more {@link MetricStream}
 * resources; the stream names are injected automatically.
 *
 * Provide `CloudWatch.StartMetricStreamsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Managing Metric Streams
 * @example Resume a Paused Metric Stream
 * ```typescript
 * // init — grants cloudwatch:StartMetricStreams on the stream
 * const startMetricStreams = yield* AWS.CloudWatch.StartMetricStreams(stream);
 *
 * // runtime
 * yield* startMetricStreams();
 * ```
 */
export interface StartMetricStreams extends Binding.Service<
  StartMetricStreams,
  "AWS.CloudWatch.StartMetricStreams",
  (
    ...streams: MetricStreams
  ) => Effect.Effect<
    () => Effect.Effect<cloudwatch.StartMetricStreamsOutput, any>
  >
> {}

export const StartMetricStreams = Binding.Service<StartMetricStreams>(
  "AWS.CloudWatch.StartMetricStreams",
);
