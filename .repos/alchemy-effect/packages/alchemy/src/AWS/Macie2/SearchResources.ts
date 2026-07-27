import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:SearchResources`.
 *
 * Retrieves (queries) statistical data and other information about Amazon Web Services resources that Amazon Macie monitors and analyzes for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.SearchResourcesHttp)`.
 * @binding
 * @section S3 Bucket Inventory
 * @example Search Buckets by Sensitivity
 * ```typescript
 * // init — account-level binding, no resource argument
 * const searchResources = yield* AWS.Macie2.SearchResources();
 *
 * // runtime
 * const { matchingResources } = yield* searchResources({});
 * ```
 */
export interface SearchResources extends Binding.Service<
  SearchResources,
  "AWS.Macie2.SearchResources",
  () => Effect.Effect<
    (
      request?: macie2.SearchResourcesRequest,
    ) => Effect.Effect<
      macie2.SearchResourcesResponse,
      macie2.SearchResourcesError
    >
  >
> {}
export const SearchResources = Binding.Service<SearchResources>(
  "AWS.Macie2.SearchResources",
);
