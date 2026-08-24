import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:ListFindingAggregators`.
 *
 * Lists the cross-Region finding aggregators configured in the account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.ListFindingAggregatorsHttp)`.
 * @binding
 * @section Custom Actions, Automation Rules & Aggregation
 * @example List Finding Aggregators
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listFindingAggregators = yield* AWS.SecurityHub.ListFindingAggregators();
 *
 * // runtime
 * const { FindingAggregators } = yield* listFindingAggregators();
 * ```
 */
export interface ListFindingAggregators extends Binding.Service<
  ListFindingAggregators,
  "AWS.SecurityHub.ListFindingAggregators",
  () => Effect.Effect<
    (
      request?: securityhub.ListFindingAggregatorsRequest,
    ) => Effect.Effect<
      securityhub.ListFindingAggregatorsResponse,
      securityhub.ListFindingAggregatorsError
    >
  >
> {}
export const ListFindingAggregators = Binding.Service<ListFindingAggregators>(
  "AWS.SecurityHub.ListFindingAggregators",
);
