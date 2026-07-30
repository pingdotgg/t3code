import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:ListFindingAggregations`.
 *
 * Lists aggregated finding data for your environment based on specific criteria.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListFindingAggregationsHttp)`.
 * @binding
 * @section Querying Findings
 * @example Aggregate Findings by Account
 * ```typescript
 * // init
 * const listFindingAggregations = yield* AWS.Inspector2.ListFindingAggregations();
 *
 * // runtime
 * const { responses } = yield* listFindingAggregations({ aggregationType: "ACCOUNT" });
 * ```
 */
export interface ListFindingAggregations extends Binding.Service<
  ListFindingAggregations,
  "AWS.Inspector2.ListFindingAggregations",
  () => Effect.Effect<
    (
      request: inspector2.ListFindingAggregationsRequest,
    ) => Effect.Effect<
      inspector2.ListFindingAggregationsResponse,
      inspector2.ListFindingAggregationsError
    >
  >
> {}
export const ListFindingAggregations = Binding.Service<ListFindingAggregations>(
  "AWS.Inspector2.ListFindingAggregations",
);
