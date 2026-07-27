import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:ListCisScanResultsAggregatedByTargetResource`.
 *
 * Lists scan results aggregated by a target resource.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListCisScanResultsAggregatedByTargetResourceHttp)`.
 * @binding
 * @section CIS Scan Results
 * @example CIS Results by Target Resource
 * ```typescript
 * // init
 * const listCisScanResultsAggregatedByTargetResource = yield* AWS.Inspector2.ListCisScanResultsAggregatedByTargetResource();
 *
 * // runtime
 * const { targetResourceAggregations } = yield* listCisScanResultsAggregatedByTargetResource({ scanArn });
 * ```
 */
export interface ListCisScanResultsAggregatedByTargetResource extends Binding.Service<
  ListCisScanResultsAggregatedByTargetResource,
  "AWS.Inspector2.ListCisScanResultsAggregatedByTargetResource",
  () => Effect.Effect<
    (
      request: inspector2.ListCisScanResultsAggregatedByTargetResourceRequest,
    ) => Effect.Effect<
      inspector2.ListCisScanResultsAggregatedByTargetResourceResponse,
      inspector2.ListCisScanResultsAggregatedByTargetResourceError
    >
  >
> {}
export const ListCisScanResultsAggregatedByTargetResource =
  Binding.Service<ListCisScanResultsAggregatedByTargetResource>(
    "AWS.Inspector2.ListCisScanResultsAggregatedByTargetResource",
  );
