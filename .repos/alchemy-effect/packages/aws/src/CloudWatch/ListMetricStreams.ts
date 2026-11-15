import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";

export interface ListMetricStreamsRequest extends cloudwatch.ListMetricStreamsInput {}

/**
 * Runtime binding for `cloudwatch:ListMetricStreams` — list the metric
 * streams in the account/region.
 *
 * Provide `CloudWatch.ListMetricStreamsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * ### Reading Metric Streams
 * **Example:** List Metric Streams
 * ```typescript
 * // init — grants cloudwatch:ListMetricStreams
 * const listMetricStreams = yield* AWS.CloudWatch.ListMetricStreams();
 *
 * // runtime
 * const result = yield* listMetricStreams();
 * const entries = result.Entries ?? [];
 * ```
 *
 * @binding
 */
export interface ListMetricStreams extends Binding.Service<
  ListMetricStreams,
  "AWS.CloudWatch.ListMetricStreams",
  () => Effect.Effect<
    (
      request?: ListMetricStreamsRequest,
    ) => Effect.Effect<cloudwatch.ListMetricStreamsOutput, cloudwatch.ListMetricStreamsError>
  >
> {}

export const ListMetricStreams = Binding.Service<ListMetricStreams>(
  "AWS.CloudWatch.ListMetricStreams",
);
