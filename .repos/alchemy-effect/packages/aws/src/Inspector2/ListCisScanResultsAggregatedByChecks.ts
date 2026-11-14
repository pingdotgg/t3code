import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `inspector2:ListCisScanResultsAggregatedByChecks`.
 *
 * Lists scan results aggregated by checks.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListCisScanResultsAggregatedByChecksHttp)`.
 * ### CIS Scan Results
 * **Example:** CIS Results by Check
 * ```typescript
 * // init
 * const listCisScanResultsAggregatedByChecks = yield* AWS.Inspector2.ListCisScanResultsAggregatedByChecks();
 *
 * // runtime
 * const { checkAggregations } = yield* listCisScanResultsAggregatedByChecks({ scanArn });
 * ```
 *
 * @binding
 */
export interface ListCisScanResultsAggregatedByChecks extends Binding.Service<
  ListCisScanResultsAggregatedByChecks,
  "AWS.Inspector2.ListCisScanResultsAggregatedByChecks",
  () => Effect.Effect<
    (
      request: inspector2.ListCisScanResultsAggregatedByChecksRequest,
    ) => Effect.Effect<
      inspector2.ListCisScanResultsAggregatedByChecksResponse,
      inspector2.ListCisScanResultsAggregatedByChecksError
    >
  >
> {}
export const ListCisScanResultsAggregatedByChecks =
  Binding.Service<ListCisScanResultsAggregatedByChecks>(
    "AWS.Inspector2.ListCisScanResultsAggregatedByChecks",
  );
