import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:ListImageScanFindingAggregations`.
 *
 * Returns Amazon Inspector finding counts grouped by severity — for the
 * whole account, or grouped by one key (`imagePipelineArn`,
 * `imageBuildVersionArn`, `accountId`, `vulnerabilityId`) when a filter is
 * supplied. Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.ListImageScanFindingAggregationsHttp)`.
 * @binding
 * @section Scan Findings
 * @example Aggregate Findings by Pipeline
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listImageScanFindingAggregations =
 *   yield* AWS.ImageBuilder.ListImageScanFindingAggregations();
 *
 * // runtime
 * const { responses } = yield* listImageScanFindingAggregations({
 *   filter: { name: "imagePipelineArn", values: [pipelineArn] },
 * });
 * ```
 */
export interface ListImageScanFindingAggregations extends Binding.Service<
  ListImageScanFindingAggregations,
  "AWS.ImageBuilder.ListImageScanFindingAggregations",
  () => Effect.Effect<
    (
      request?: imagebuilder.ListImageScanFindingAggregationsRequest,
    ) => Effect.Effect<
      imagebuilder.ListImageScanFindingAggregationsResponse,
      imagebuilder.ListImageScanFindingAggregationsError
    >
  >
> {}
export const ListImageScanFindingAggregations =
  Binding.Service<ListImageScanFindingAggregations>(
    "AWS.ImageBuilder.ListImageScanFindingAggregations",
  );
