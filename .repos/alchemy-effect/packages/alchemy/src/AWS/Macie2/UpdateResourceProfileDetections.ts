import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:UpdateResourceProfileDetections`.
 *
 * Updates the sensitivity scoring settings for an S3 bucket.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.UpdateResourceProfileDetectionsHttp)`.
 * @binding
 * @section Automated Discovery
 * @example Suppress a Detection on a Bucket
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateResourceProfileDetections = yield* AWS.Macie2.UpdateResourceProfileDetections();
 *
 * // runtime
 * yield* updateResourceProfileDetections({
 *   resourceArn: bucketArn,
 *   suppressDataIdentifiers: [{ id: identifierId, type: "MANAGED" }],
 * });
 * ```
 */
export interface UpdateResourceProfileDetections extends Binding.Service<
  UpdateResourceProfileDetections,
  "AWS.Macie2.UpdateResourceProfileDetections",
  () => Effect.Effect<
    (
      request?: macie2.UpdateResourceProfileDetectionsRequest,
    ) => Effect.Effect<
      macie2.UpdateResourceProfileDetectionsResponse,
      macie2.UpdateResourceProfileDetectionsError
    >
  >
> {}
export const UpdateResourceProfileDetections =
  Binding.Service<UpdateResourceProfileDetections>(
    "AWS.Macie2.UpdateResourceProfileDetections",
  );
