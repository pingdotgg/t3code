import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:StartBuildBatch` — kicks off a batch
 * (fan-out) build of the bound project. The project must have a build batch
 * configuration and the buildspec a `batch:` section.
 * @binding
 * @section Batch Builds
 * @example Start a Batch Build
 * ```typescript
 * const startBuildBatch = yield* AWS.CodeBuild.StartBuildBatch(project);
 *
 * const { buildBatch } = yield* startBuildBatch();
 * ```
 */
export interface StartBuildBatch extends Binding.Service<
  StartBuildBatch,
  "AWS.CodeBuild.StartBuildBatch",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.StartBuildBatchInput, "projectName">,
    ) => Effect.Effect<SVC.StartBuildBatchOutput, SVC.StartBuildBatchError>
  >
> {}
export const StartBuildBatch = Binding.Service<StartBuildBatch>(
  "AWS.CodeBuild.StartBuildBatch",
);
