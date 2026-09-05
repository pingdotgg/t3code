import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:StopBuildBatch` — stops an in-progress
 * batch build of the bound project by batch id.
 * @binding
 * @section Batch Builds
 * @example Stop a Batch Build
 * ```typescript
 * const stopBuildBatch = yield* AWS.CodeBuild.StopBuildBatch(project);
 *
 * yield* stopBuildBatch({ id: batchId });
 * ```
 */
export interface StopBuildBatch extends Binding.Service<
  StopBuildBatch,
  "AWS.CodeBuild.StopBuildBatch",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.StopBuildBatchInput,
    ) => Effect.Effect<SVC.StopBuildBatchOutput, SVC.StopBuildBatchError>
  >
> {}
export const StopBuildBatch = Binding.Service<StopBuildBatch>(
  "AWS.CodeBuild.StopBuildBatch",
);
