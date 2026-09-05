import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetResourceProfile`.
 *
 * Retrieves (queries) sensitive data discovery statistics and the sensitivity score for an S3 bucket.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetResourceProfileHttp)`.
 * @binding
 * @section Automated Discovery
 * @example Read a Bucket's Sensitivity Profile
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getResourceProfile = yield* AWS.Macie2.GetResourceProfile();
 *
 * // runtime
 * const profile = yield* getResourceProfile({ resourceArn: bucketArn });
 * ```
 */
export interface GetResourceProfile extends Binding.Service<
  GetResourceProfile,
  "AWS.Macie2.GetResourceProfile",
  () => Effect.Effect<
    (
      request?: macie2.GetResourceProfileRequest,
    ) => Effect.Effect<
      macie2.GetResourceProfileResponse,
      macie2.GetResourceProfileError
    >
  >
> {}
export const GetResourceProfile = Binding.Service<GetResourceProfile>(
  "AWS.Macie2.GetResourceProfile",
);
