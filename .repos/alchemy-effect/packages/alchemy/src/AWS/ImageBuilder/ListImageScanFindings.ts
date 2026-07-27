import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:ListImageScanFindings`.
 *
 * Lists Amazon Inspector scan findings for images in the account (populated
 * when a pipeline has `imageScanningConfiguration` enabled). Filter by
 * `imageBuildVersionArn` or `imagePipelineArn` to narrow to one build or
 * pipeline. Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.ListImageScanFindingsHttp)`.
 * @binding
 * @section Scan Findings
 * @example List Findings for a Pipeline's Builds
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listImageScanFindings =
 *   yield* AWS.ImageBuilder.ListImageScanFindings();
 *
 * // runtime
 * const { findings } = yield* listImageScanFindings({
 *   filters: [{ name: "imagePipelineArn", values: [pipelineArn] }],
 * });
 * ```
 */
export interface ListImageScanFindings extends Binding.Service<
  ListImageScanFindings,
  "AWS.ImageBuilder.ListImageScanFindings",
  () => Effect.Effect<
    (
      request?: imagebuilder.ListImageScanFindingsRequest,
    ) => Effect.Effect<
      imagebuilder.ListImageScanFindingsResponse,
      imagebuilder.ListImageScanFindingsError
    >
  >
> {}
export const ListImageScanFindings = Binding.Service<ListImageScanFindings>(
  "AWS.ImageBuilder.ListImageScanFindings",
);
