import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:ListUsageTotals`.
 *
 * Lists the Amazon Inspector usage totals over the last 30 days.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListUsageTotalsHttp)`.
 * @binding
 * @section Account Settings & Usage
 * @example Monthly Usage Totals
 * ```typescript
 * // init
 * const listUsageTotals = yield* AWS.Inspector2.ListUsageTotals();
 *
 * // runtime
 * const { totals } = yield* listUsageTotals();
 * ```
 */
export interface ListUsageTotals extends Binding.Service<
  ListUsageTotals,
  "AWS.Inspector2.ListUsageTotals",
  () => Effect.Effect<
    (
      request?: inspector2.ListUsageTotalsRequest,
    ) => Effect.Effect<
      inspector2.ListUsageTotalsResponse,
      inspector2.ListUsageTotalsError
    >
  >
> {}
export const ListUsageTotals = Binding.Service<ListUsageTotals>(
  "AWS.Inspector2.ListUsageTotals",
);
