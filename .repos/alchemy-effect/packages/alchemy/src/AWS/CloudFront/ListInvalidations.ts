import type * as cloudfront from "@distilled.cloud/aws/cloudfront";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Distribution } from "./Distribution.ts";

export interface ListInvalidationsRequest extends Omit<
  cloudfront.ListInvalidationsRequest,
  "DistributionId"
> {}

/**
 * Runtime binding for `cloudfront:ListInvalidations`.
 *
 * Lists the cache invalidations of the bound distribution (paginated via
 * `Marker`/`MaxItems`). Provide the implementation with
 * `Effect.provide(AWS.CloudFront.ListInvalidationsHttp)`.
 * @binding
 * @section Inspecting Invalidations
 * @example List Recent Invalidations
 * ```typescript
 * // init — bind the operation to the distribution
 * const listInvalidations = yield* CloudFront.ListInvalidations(distribution);
 *
 * // runtime
 * const res = yield* listInvalidations({ MaxItems: 10 });
 * console.log(res.InvalidationList?.Items?.map((i) => i.Id));
 * ```
 */
export interface ListInvalidations extends Binding.Service<
  ListInvalidations,
  "AWS.CloudFront.ListInvalidations",
  (
    distribution: Distribution,
  ) => Effect.Effect<
    (
      request: ListInvalidationsRequest,
    ) => Effect.Effect<
      cloudfront.ListInvalidationsResult,
      cloudfront.ListInvalidationsError
    >
  >
> {}

export const ListInvalidations = Binding.Service<ListInvalidations>(
  "AWS.CloudFront.ListInvalidations",
);
