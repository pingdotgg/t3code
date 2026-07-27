import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListResourceProfileDetections`.
 *
 * Retrieves information about the types and amount of sensitive data that Amazon Macie found in an S3 bucket.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListResourceProfileDetectionsHttp)`.
 * @binding
 * @section Automated Discovery
 * @example List a Profile's Detections
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listResourceProfileDetections = yield* AWS.Macie2.ListResourceProfileDetections();
 *
 * // runtime
 * const { detections } = yield* listResourceProfileDetections({ resourceArn: bucketArn });
 * ```
 */
export interface ListResourceProfileDetections extends Binding.Service<
  ListResourceProfileDetections,
  "AWS.Macie2.ListResourceProfileDetections",
  () => Effect.Effect<
    (
      request?: macie2.ListResourceProfileDetectionsRequest,
    ) => Effect.Effect<
      macie2.ListResourceProfileDetectionsResponse,
      macie2.ListResourceProfileDetectionsError
    >
  >
> {}
export const ListResourceProfileDetections =
  Binding.Service<ListResourceProfileDetections>(
    "AWS.Macie2.ListResourceProfileDetections",
  );
