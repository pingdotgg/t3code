import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:BatchDeleteBuilds` — deletes builds of
 * the bound project by id. Builds that cannot be deleted are returned in
 * `buildsNotDeleted` with a reason rather than failing the call.
 * @binding
 * @section Deleting Builds
 * @example Delete Old Builds
 * ```typescript
 * const batchDeleteBuilds = yield* AWS.CodeBuild.BatchDeleteBuilds(project);
 *
 * const { buildsDeleted, buildsNotDeleted } = yield* batchDeleteBuilds({
 *   ids: oldBuildIds,
 * });
 * ```
 */
export interface BatchDeleteBuilds extends Binding.Service<
  BatchDeleteBuilds,
  "AWS.CodeBuild.BatchDeleteBuilds",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.BatchDeleteBuildsInput,
    ) => Effect.Effect<SVC.BatchDeleteBuildsOutput, SVC.BatchDeleteBuildsError>
  >
> {}
export const BatchDeleteBuilds = Binding.Service<BatchDeleteBuilds>(
  "AWS.CodeBuild.BatchDeleteBuilds",
);
