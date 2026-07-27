import type * as s3control from "@distilled.cloud/aws/s3-control";
import type * as sts from "@distilled.cloud/aws/sts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `s3:ListAccessPoints`.
 *
 * Lists the access points in the caller's account, optionally filtered to a
 * single bucket — e.g. an inventory Lambda that audits which endpoints
 * expose a shared dataset. The account id is resolved once via
 * `sts:GetCallerIdentity`. Provide the implementation with
 * `Effect.provide(AWS.S3Control.ListAccessPointsHttp)`.
 * @binding
 * @section Listing Access Points
 * @example List the Access Points on a Bucket
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listAccessPoints = yield* AWS.S3Control.ListAccessPoints();
 *
 * // runtime
 * const page = yield* listAccessPoints({ Bucket: bucketName });
 * // page.AccessPointList?.map((ap) => ap.Name)
 * ```
 */
export interface ListAccessPoints extends Binding.Service<
  ListAccessPoints,
  "AWS.S3Control.ListAccessPoints",
  () => Effect.Effect<
    (
      request?: Omit<s3control.ListAccessPointsRequest, "AccountId">,
    ) => Effect.Effect<
      s3control.ListAccessPointsResult,
      s3control.ListAccessPointsError | sts.GetCallerIdentityError
    >
  >
> {}
export const ListAccessPoints = Binding.Service<ListAccessPoints>(
  "AWS.S3Control.ListAccessPoints",
);
