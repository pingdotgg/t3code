import type * as cloudfront from "@distilled.cloud/aws/cloudfront";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Distribution } from "./Distribution.ts";

export interface CreateInvalidationRequest extends Omit<
  cloudfront.CreateInvalidationRequest,
  "DistributionId"
> {}

/**
 * Grants a Function permission to create CloudFront cache invalidations for a
 * distribution at runtime — the classic post-publish/CMS purge pattern.
 * @binding
 * @section Invalidating from a Function
 * @example Purge Paths After a Content Update
 * ```typescript
 * const invalidate = yield* CloudFront.CreateInvalidation(distribution);
 *
 * const response = yield* invalidate({
 *   InvalidationBatch: {
 *     CallerReference: crypto.randomUUID(),
 *     Paths: { Quantity: 1, Items: ["/blog/*"] },
 *   },
 * });
 * // response.Invalidation?.Id
 * ```
 */
export interface CreateInvalidation extends Binding.Service<
  CreateInvalidation,
  "AWS.CloudFront.CreateInvalidation",
  (
    distribution: Distribution,
  ) => Effect.Effect<
    (
      request: CreateInvalidationRequest,
    ) => Effect.Effect<
      cloudfront.CreateInvalidationResult,
      cloudfront.CreateInvalidationError
    >
  >
> {}

export const CreateInvalidation = Binding.Service<CreateInvalidation>(
  "AWS.CloudFront.CreateInvalidation",
);
