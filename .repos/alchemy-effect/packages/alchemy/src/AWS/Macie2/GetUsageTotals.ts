import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetUsageTotals`.
 *
 * Retrieves (queries) aggregated usage data for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetUsageTotalsHttp)`.
 * @binding
 * @section Usage & Quotas
 * @example Aggregated Usage Totals
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getUsageTotals = yield* AWS.Macie2.GetUsageTotals();
 *
 * // runtime
 * const { usageTotals } = yield* getUsageTotals();
 * ```
 */
export interface GetUsageTotals extends Binding.Service<
  GetUsageTotals,
  "AWS.Macie2.GetUsageTotals",
  () => Effect.Effect<
    (
      request?: macie2.GetUsageTotalsRequest,
    ) => Effect.Effect<
      macie2.GetUsageTotalsResponse,
      macie2.GetUsageTotalsError
    >
  >
> {}
export const GetUsageTotals = Binding.Service<GetUsageTotals>(
  "AWS.Macie2.GetUsageTotals",
);
