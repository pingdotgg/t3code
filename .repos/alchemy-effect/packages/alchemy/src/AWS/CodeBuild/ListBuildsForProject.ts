import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:ListBuildsForProject` — lists the bound
 * project's build ids, newest first. Page with `nextToken`; resolve ids to
 * statuses with {@link BatchGetBuilds}.
 * @binding
 * @section Listing Builds
 * @example List Recent Builds
 * ```typescript
 * const listBuilds = yield* AWS.CodeBuild.ListBuildsForProject(project);
 *
 * const { ids } = yield* listBuilds();
 * ```
 */
export interface ListBuildsForProject extends Binding.Service<
  ListBuildsForProject,
  "AWS.CodeBuild.ListBuildsForProject",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListBuildsForProjectInput, "projectName">,
    ) => Effect.Effect<
      SVC.ListBuildsForProjectOutput,
      SVC.ListBuildsForProjectError
    >
  >
> {}
export const ListBuildsForProject = Binding.Service<ListBuildsForProject>(
  "AWS.CodeBuild.ListBuildsForProject",
);
