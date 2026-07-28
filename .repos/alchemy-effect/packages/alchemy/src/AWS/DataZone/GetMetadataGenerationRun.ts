import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface GetMetadataGenerationRunRequest extends Omit<
  datazone.GetMetadataGenerationRunInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:GetMetadataGenerationRun`.
 *
 * Reads the status of a metadata generation run in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.GetMetadataGenerationRunHttp)`.
 * @binding
 * @section Metadata Generation
 * @example Check a Generation Run
 * ```typescript
 * // init — bind the operation to the domain
 * const getMetadataGenerationRun = yield* AWS.DataZone.GetMetadataGenerationRun(domain);
 *
 * // runtime
 * const run = yield* getMetadataGenerationRun({ identifier: runId });
 * ```
 */
export interface GetMetadataGenerationRun extends Binding.Service<
  GetMetadataGenerationRun,
  "AWS.DataZone.GetMetadataGenerationRun",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: GetMetadataGenerationRunRequest,
    ) => Effect.Effect<
      datazone.GetMetadataGenerationRunOutput,
      datazone.GetMetadataGenerationRunError
    >
  >
> {}
export const GetMetadataGenerationRun =
  Binding.Service<GetMetadataGenerationRun>(
    "AWS.DataZone.GetMetadataGenerationRun",
  );
