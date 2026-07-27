import type * as cloudfront from "@distilled.cloud/aws/cloudfront";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Distribution } from "./Distribution.ts";

export interface GetInvalidationRequest extends Omit<
  cloudfront.GetInvalidationRequest,
  "DistributionId"
> {}

/**
 * Runtime binding for `cloudfront:GetInvalidation`.
 *
 * Reads the status of a cache invalidation on the bound distribution —
 * pairs with {@link CreateInvalidation} to poll a purge to `Completed`.
 * Provide the implementation with
 * `Effect.provide(AWS.CloudFront.GetInvalidationHttp)`.
 * @binding
 * @section Inspecting Invalidations
 * @example Poll an Invalidation's Status
 * ```typescript
 * // init — bind the operation to the distribution
 * const getInvalidation = yield* CloudFront.GetInvalidation(distribution);
 *
 * // runtime
 * const res = yield* getInvalidation({ Id: invalidationId });
 * console.log(res.Invalidation?.Status); // "InProgress" | "Completed"
 * ```
 */
export interface GetInvalidation extends Binding.Service<
  GetInvalidation,
  "AWS.CloudFront.GetInvalidation",
  (
    distribution: Distribution,
  ) => Effect.Effect<
    (
      request: GetInvalidationRequest,
    ) => Effect.Effect<
      cloudfront.GetInvalidationResult,
      cloudfront.GetInvalidationError
    >
  >
> {}

export const GetInvalidation = Binding.Service<GetInvalidation>(
  "AWS.CloudFront.GetInvalidation",
);
