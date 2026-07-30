import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeLimitsRequest extends Kinesis.DescribeLimitsInput {}

/**
 * Runtime binding for `kinesis:DescribeLimits`.
 *
 * An account-level operation (no stream argument) that reports shard quotas
 * and current usage for the region. Provide the implementation with
 * `Effect.provide(AWS.Kinesis.DescribeLimitsHttp)`.
 * @binding
 * @section Account Settings
 * @example Check Shard Quota Headroom
 * ```typescript
 * // init — account-level binding takes no resource
 * const describeLimits = yield* AWS.Kinesis.DescribeLimits();
 *
 * // runtime
 * const limits = yield* describeLimits();
 * const headroom = (limits.ShardLimit ?? 0) - (limits.OpenShardCount ?? 0);
 * ```
 */
export interface DescribeLimits extends Binding.Service<
  DescribeLimits,
  "AWS.Kinesis.DescribeLimits",
  () => Effect.Effect<
    (
      request?: DescribeLimitsRequest,
    ) => Effect.Effect<
      Kinesis.DescribeLimitsOutput,
      Kinesis.DescribeLimitsError
    >
  >
> {}

export const DescribeLimits = Binding.Service<DescribeLimits>(
  "AWS.Kinesis.DescribeLimits",
);
