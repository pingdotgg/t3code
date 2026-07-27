import type * as shield from "@distilled.cloud/aws/shield";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `shield:DescribeDRTAccess`.
 *
 * Returns the IAM role and S3 log buckets the Shield Response Team (SRT) is
 * currently authorized to use while assisting with attack mitigation —
 * useful for security-posture audit handlers. Requires an active Shield
 * Advanced subscription; without one the call fails with the typed
 * `ResourceNotFoundException`.
 * Provide the implementation with
 * `Effect.provide(AWS.Shield.DescribeDRTAccessHttp)`.
 * @binding
 * @section Shield Response Team Access
 * @example Audit SRT Access
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeDRTAccess = yield* AWS.Shield.DescribeDRTAccess();
 *
 * // runtime
 * const { RoleArn, LogBucketList } = yield* describeDRTAccess();
 * ```
 */
export interface DescribeDRTAccess extends Binding.Service<
  DescribeDRTAccess,
  "AWS.Shield.DescribeDRTAccess",
  () => Effect.Effect<
    (
      request?: shield.DescribeDRTAccessRequest,
    ) => Effect.Effect<
      shield.DescribeDRTAccessResponse,
      shield.DescribeDRTAccessError
    >
  >
> {}
export const DescribeDRTAccess = Binding.Service<DescribeDRTAccess>(
  "AWS.Shield.DescribeDRTAccess",
);
