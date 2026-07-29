import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:RetryBuild` — restarts a finished
 * (failed, stopped, …) build of the bound project by build id, producing a
 * new build.
 * @binding
 * @section Retrying Builds
 * @example Retry a Failed Build
 * ```typescript
 * const retryBuild = yield* AWS.CodeBuild.RetryBuild(project);
 *
 * const { build } = yield* retryBuild({ id: failedBuildId });
 * ```
 */
export interface RetryBuild extends Binding.Service<
  RetryBuild,
  "AWS.CodeBuild.RetryBuild",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.RetryBuildInput,
    ) => Effect.Effect<SVC.RetryBuildOutput, SVC.RetryBuildError>
  >
> {}
export const RetryBuild = Binding.Service<RetryBuild>(
  "AWS.CodeBuild.RetryBuild",
);
