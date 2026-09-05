import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:ListCisScanResultsAggregatedByChecks`.
 *
 * Lists scan results aggregated by checks.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListCisScanResultsAggregatedByChecksHttp)`.
 * @binding
 * @section CIS Scan Results
 * @example CIS Results by Check
 * ```typescript
 * // init
 * const listCisScanResultsAggregatedByChecks = yield* AWS.Inspector2.ListCisScanResultsAggregatedByChecks();
 *
 * // runtime
 * const { checkAggregations } = yield* listCisScanResultsAggregatedByChecks({ scanArn });
 * ```
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
