import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:DeleteBuildBatch` — deletes a batch build
 * of the bound project (and its child builds) by batch id.
 * @binding
 * @section Batch Builds
 * @example Delete a Batch Build
 * ```typescript
 * const deleteBuildBatch = yield* AWS.CodeBuild.DeleteBuildBatch(project);
 *
 * yield* deleteBuildBatch({ id: batchId });
 * ```
 */
export interface DeleteBuildBatch extends Binding.Service<
  DeleteBuildBatch,
  "AWS.CodeBuild.DeleteBuildBatch",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.DeleteBuildBatchInput,
    ) => Effect.Effect<SVC.DeleteBuildBatchOutput, SVC.DeleteBuildBatchError>
  >
> {}
export const DeleteBuildBatch = Binding.Service<DeleteBuildBatch>(
  "AWS.CodeBuild.DeleteBuildBatch",
);
