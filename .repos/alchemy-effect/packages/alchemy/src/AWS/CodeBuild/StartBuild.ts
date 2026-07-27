import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

export interface StartBuildRequest extends Omit<
  SVC.StartBuildInput,
  "projectName"
> {}

/**
 * Runtime binding for `codebuild:StartBuild` — lets a workload kick off a
 * build of a CodeBuild project (optionally overriding the source version,
 * environment variables, buildspec, etc.).
 *
 * The response carries the created `build` including its `id`, which can be
 * polled with the {@link BatchGetBuilds} binding.
 * @binding
 * @section Starting Builds
 * @example Start a Build
 * ```typescript
 * const startBuild = yield* AWS.CodeBuild.StartBuild(project);
 *
 * const { build } = yield* startBuild({
 *   environmentVariablesOverride: [
 *     { name: "COMMIT", value: sha, type: "PLAINTEXT" },
 *   ],
 * });
 * ```
 */
export interface StartBuild extends Binding.Service<
  StartBuild,
  "AWS.CodeBuild.StartBuild",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request?: StartBuildRequest,
    ) => Effect.Effect<SVC.StartBuildOutput, SVC.StartBuildError>
  >
> {}
export const StartBuild = Binding.Service<StartBuild>(
  "AWS.CodeBuild.StartBuild",
);
