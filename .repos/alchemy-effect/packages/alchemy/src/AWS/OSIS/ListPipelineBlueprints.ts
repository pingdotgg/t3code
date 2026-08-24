import type * as osis from "@distilled.cloud/aws/osis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `osis:ListPipelineBlueprints`.
 *
 * Lists the available Data Prepper blueprints — AWS-provided configuration
 * templates for common source/sink topologies — so config-authoring tooling
 * can offer them as starting points. Account-level: no resource argument.
 * Provide the implementation with
 * `Effect.provide(AWS.OSIS.ListPipelineBlueprintsHttp)`.
 * @binding
 * @section Authoring Pipeline Configurations
 * @example List Available Blueprints
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listPipelineBlueprints = yield* AWS.OSIS.ListPipelineBlueprints();
 *
 * // runtime
 * const { Blueprints } = yield* listPipelineBlueprints();
 * // [{ BlueprintName: "AWS-CloudTrailLogsToOpenSearch", ... }, ...]
 * ```
 */
export interface ListPipelineBlueprints extends Binding.Service<
  ListPipelineBlueprints,
  "AWS.OSIS.ListPipelineBlueprints",
  () => Effect.Effect<
    (
      request?: osis.ListPipelineBlueprintsRequest,
    ) => Effect.Effect<
      osis.ListPipelineBlueprintsResponse,
      osis.ListPipelineBlueprintsError
    >
  >
> {}
export const ListPipelineBlueprints = Binding.Service<ListPipelineBlueprints>(
  "AWS.OSIS.ListPipelineBlueprints",
);
