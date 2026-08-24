import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:StopBuild` — stops an in-progress build
 * of the bound project by build id.
 * @binding
 * @section Stopping Builds
 * @example Stop a Running Build
 * ```typescript
 * const stopBuild = yield* AWS.CodeBuild.StopBuild(project);
 *
 * const { build } = yield* stopBuild({ id: buildId });
 * // build.buildStatus transitions to "STOPPED"
 * ```
 */
export interface StopBuild extends Binding.Service<
  StopBuild,
  "AWS.CodeBuild.StopBuild",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.StopBuildInput,
    ) => Effect.Effect<SVC.StopBuildOutput, SVC.StopBuildError>
  >
> {}
export const StopBuild = Binding.Service<StopBuild>("AWS.CodeBuild.StopBuild");
