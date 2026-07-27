import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:RetryBuildBatch` — restarts a finished
 * batch build of the bound project, retrying either all builds or only the
 * failed ones (`retryType`).
 * @binding
 * @section Batch Builds
 * @example Retry Failed Builds in a Batch
 * ```typescript
 * const retryBuildBatch = yield* AWS.CodeBuild.RetryBuildBatch(project);
 *
 * yield* retryBuildBatch({ id: batchId, retryType: "RETRY_FAILED_BUILDS" });
 * ```
 */
export interface RetryBuildBatch extends Binding.Service<
  RetryBuildBatch,
  "AWS.CodeBuild.RetryBuildBatch",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.RetryBuildBatchInput,
    ) => Effect.Effect<SVC.RetryBuildBatchOutput, SVC.RetryBuildBatchError>
  >
> {}
export const RetryBuildBatch = Binding.Service<RetryBuildBatch>(
  "AWS.CodeBuild.RetryBuildBatch",
);
