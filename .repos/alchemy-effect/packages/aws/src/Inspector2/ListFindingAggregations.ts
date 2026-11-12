import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `inspector2:ListFindingAggregations`.
 *
 * Lists aggregated finding data for your environment based on specific criteria.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListFindingAggregationsHttp)`.
 * ### Querying Findings
 * **Example:** Aggregate Findings by Account
 * ```typescript
 * // init
 * const listFindingAggregations = yield* AWS.Inspector2.ListFindingAggregations();
 *
 * // runtime
 * const { responses } = yield* listFindingAggregations({ aggregationType: "ACCOUNT" });
 * ```
 *
 * @binding
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
