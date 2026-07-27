import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface StartMetadataGenerationRunRequest extends Omit<
  datazone.StartMetadataGenerationRunInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:StartMetadataGenerationRun`.
 *
 * Starts an ML metadata generation run (business description suggestions) for an asset in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.StartMetadataGenerationRunHttp)`.
 * @binding
 * @section Metadata Generation
 * @example Generate Business Descriptions
 * ```typescript
 * // init — bind the operation to the domain
 * const startMetadataGenerationRun = yield* AWS.DataZone.StartMetadataGenerationRun(domain);
 *
 * // runtime
 * const run = yield* startMetadataGenerationRun({
 *   types: ["BUSINESS_DESCRIPTIONS"],
 *   target: { type: "ASSET", identifier: assetId },
 *   owningProjectIdentifier: projectId,
 * });
 * ```
 */
export interface StartMetadataGenerationRun extends Binding.Service<
  StartMetadataGenerationRun,
  "AWS.DataZone.StartMetadataGenerationRun",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: StartMetadataGenerationRunRequest,
    ) => Effect.Effect<
      datazone.StartMetadataGenerationRunOutput,
      datazone.StartMetadataGenerationRunError
    >
  >
> {}
export const StartMetadataGenerationRun =
  Binding.Service<StartMetadataGenerationRun>(
    "AWS.DataZone.StartMetadataGenerationRun",
  );
