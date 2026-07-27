import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:BatchGetBuildBatches` — reads the status
 * of one or more batch builds of the bound project by batch id.
 * @binding
 * @section Batch Builds
 * @example Poll a Batch Build
 * ```typescript
 * const batchGetBuildBatches = yield* AWS.CodeBuild.BatchGetBuildBatches(project);
 *
 * const { buildBatches } = yield* batchGetBuildBatches({ ids: [batchId] });
 * ```
 */
export interface BatchGetBuildBatches extends Binding.Service<
  BatchGetBuildBatches,
  "AWS.CodeBuild.BatchGetBuildBatches",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.BatchGetBuildBatchesInput,
    ) => Effect.Effect<
      SVC.BatchGetBuildBatchesOutput,
      SVC.BatchGetBuildBatchesError
    >
  >
> {}
export const BatchGetBuildBatches = Binding.Service<BatchGetBuildBatches>(
  "AWS.CodeBuild.BatchGetBuildBatches",
);
