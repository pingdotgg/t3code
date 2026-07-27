import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:ListBuildBatchesForProject` — lists the
 * bound project's batch build ids, optionally filtered by status.
 * @binding
 * @section Batch Builds
 * @example List Batch Builds
 * ```typescript
 * const listBuildBatches = yield* AWS.CodeBuild.ListBuildBatchesForProject(project);
 *
 * const { ids } = yield* listBuildBatches();
 * ```
 */
export interface ListBuildBatchesForProject extends Binding.Service<
  ListBuildBatchesForProject,
  "AWS.CodeBuild.ListBuildBatchesForProject",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListBuildBatchesForProjectInput, "projectName">,
    ) => Effect.Effect<
      SVC.ListBuildBatchesForProjectOutput,
      SVC.ListBuildBatchesForProjectError
    >
  >
> {}
export const ListBuildBatchesForProject =
  Binding.Service<ListBuildBatchesForProject>(
    "AWS.CodeBuild.ListBuildBatchesForProject",
  );
