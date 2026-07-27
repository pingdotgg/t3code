import type * as osis from "@distilled.cloud/aws/osis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

/**
 * Runtime binding for `osis:GetPipelineChangeProgress`.
 *
 * Reads progress information for the current change happening on the bound
 * {@link Pipeline} (stage-by-stage status while the pipeline is being
 * created) — useful for surfacing provisioning progress in an operational
 * dashboard. The pipeline name is injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.OSIS.GetPipelineChangeProgressHttp)`.
 * @binding
 * @section Monitoring a Pipeline
 * @example Report Creation Progress
 * ```typescript
 * // init — bind the operation to the pipeline
 * const getChangeProgress = yield* AWS.OSIS.GetPipelineChangeProgress(pipeline);
 *
 * // runtime
 * const { ChangeProgressStatuses } = yield* getChangeProgress();
 * for (const status of ChangeProgressStatuses ?? []) {
 *   yield* Effect.log(`${status.Status}: ${status.ChangeProgressStages?.length} stages`);
 * }
 * ```
 */
export interface GetPipelineChangeProgress extends Binding.Service<
  GetPipelineChangeProgress,
  "AWS.OSIS.GetPipelineChangeProgress",
  (
    pipeline: Pipeline,
  ) => Effect.Effect<
    () => Effect.Effect<
      osis.GetPipelineChangeProgressResponse,
      osis.GetPipelineChangeProgressError
    >
  >
> {}
export const GetPipelineChangeProgress =
  Binding.Service<GetPipelineChangeProgress>(
    "AWS.OSIS.GetPipelineChangeProgress",
  );
