import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:UpdateResourceProfile`.
 *
 * Updates the sensitivity score for an S3 bucket.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.UpdateResourceProfileHttp)`.
 * @binding
 * @section Automated Discovery
 * @example Override a Bucket's Sensitivity Score
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateResourceProfile = yield* AWS.Macie2.UpdateResourceProfile();
 *
 * // runtime
 * yield* updateResourceProfile({ resourceArn: bucketArn, sensitivityScoreOverride: 100 });
 * ```
 */
export interface UpdateResourceProfile extends Binding.Service<
  UpdateResourceProfile,
  "AWS.Macie2.UpdateResourceProfile",
  () => Effect.Effect<
    (
      request?: macie2.UpdateResourceProfileRequest,
    ) => Effect.Effect<
      macie2.UpdateResourceProfileResponse,
      macie2.UpdateResourceProfileError
    >
  >
> {}
export const UpdateResourceProfile = Binding.Service<UpdateResourceProfile>(
  "AWS.Macie2.UpdateResourceProfile",
);
