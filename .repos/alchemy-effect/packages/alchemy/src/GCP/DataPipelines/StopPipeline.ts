import type * as datapipelines from "@distilled.cloud/gcp/datapipelines_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface StopPipelineRequest extends Omit<
  datapipelines.StopProjectsLocationsPipelinesRequest,
  "name"
> {}

/**
 * Runtime binding for Data Pipelines `pipelines.stop`.
 *
 * Grants `roles/datapipelines.admin` on the project because
 * `datapipelines.pipelines.stop` is only in that role and Data Pipelines has
 * no per-resource IAM.
 *
 * Freezes pipeline execution permanently (state becomes `STATE_ARCHIVED`)
 * and deletes any attached scheduler job. Bind in a Function/Action init
 * phase and provide {@link StopPipelineHttp}.
 *
 * ### Stopping Pipelines
 * **Example:** Archive the bound pipeline
 * ```typescript
 * const stopPipeline = yield* GCP.DataPipelines.StopPipeline(batch);
 * const archived = yield* stopPipeline();
 * ```
 *
 * @binding
 * @category DataPipelines
 */
export interface StopPipeline extends Binding.Service<
  StopPipeline,
  "GCP.DataPipelines.StopPipeline",
  (
    pipeline: Pipeline,
  ) => Effect.Effect<
    (
      request?: StopPipelineRequest,
    ) => Effect.Effect<
      datapipelines.GoogleCloudDatapipelinesV1Pipeline,
      datapipelines.StopProjectsLocationsPipelinesError,
      RuntimeContext
    >
  >
> {}

export const StopPipeline = Binding.Service<StopPipeline>(
  "GCP.DataPipelines.StopPipeline",
);
