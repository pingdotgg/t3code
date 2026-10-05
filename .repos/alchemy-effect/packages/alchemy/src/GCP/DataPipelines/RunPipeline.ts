import type * as datapipelines from "@distilled.cloud/gcp/datapipelines_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface RunPipelineRequest extends Omit<
  datapipelines.RunProjectsLocationsPipelinesRequest,
  "name"
> {}

/**
 * Runtime binding for Data Pipelines `pipelines.run`.
 *
 * Creates a job for the bound pipeline immediately. Use this when the
 * internal scheduler is not configured. Bind in a Function/Action init
 * phase and provide {@link RunPipelineHttp}.
 *
 * ### Running Pipelines
 * **Example:** Run the bound pipeline now
 * ```typescript
 * const runPipeline = yield* GCP.DataPipelines.RunPipeline(batch);
 * const response = yield* runPipeline();
 * ```
 *
 * @binding
 * @category DataPipelines
 */
export interface RunPipeline extends Binding.Service<
  RunPipeline,
  "GCP.DataPipelines.RunPipeline",
  (
    pipeline: Pipeline,
  ) => Effect.Effect<
    (
      request?: RunPipelineRequest,
    ) => Effect.Effect<
      datapipelines.GoogleCloudDatapipelinesV1RunPipelineResponse,
      datapipelines.RunProjectsLocationsPipelinesError,
      RuntimeContext
    >
  >
> {}

export const RunPipeline = Binding.Service<RunPipeline>(
  "GCP.DataPipelines.RunPipeline",
);
