import type * as osis from "@distilled.cloud/aws/osis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `osis:GetPipelineBlueprint`.
 *
 * Retrieves one Data Prepper blueprint's full configuration template so
 * config-authoring tooling can render or specialize it (pair with
 * {@link ListPipelineBlueprints} to discover blueprint names). Account-level:
 * no resource argument. Provide the implementation with
 * `Effect.provide(AWS.OSIS.GetPipelineBlueprintHttp)`.
 * @binding
 * @section Authoring Pipeline Configurations
 * @example Fetch a Blueprint's Template
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getPipelineBlueprint = yield* AWS.OSIS.GetPipelineBlueprint();
 *
 * // runtime
 * const { Blueprint } = yield* getPipelineBlueprint({
 *   BlueprintName: "AWS-ApacheLogPipeline",
 * });
 * // Blueprint?.PipelineConfigurationBody — the YAML template
 * ```
 */
export interface GetPipelineBlueprint extends Binding.Service<
  GetPipelineBlueprint,
  "AWS.OSIS.GetPipelineBlueprint",
  () => Effect.Effect<
    (
      request: osis.GetPipelineBlueprintRequest,
    ) => Effect.Effect<
      osis.GetPipelineBlueprintResponse,
      osis.GetPipelineBlueprintError
    >
  >
> {}
export const GetPipelineBlueprint = Binding.Service<GetPipelineBlueprint>(
  "AWS.OSIS.GetPipelineBlueprint",
);
