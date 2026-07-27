import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:ListSandboxesForProject` — lists the
 * bound project's sandbox ids, newest first.
 * @binding
 * @section Sandboxes
 * @example List Sandboxes
 * ```typescript
 * const listSandboxes = yield* AWS.CodeBuild.ListSandboxesForProject(project);
 *
 * const { ids } = yield* listSandboxes();
 * ```
 */
export interface ListSandboxesForProject extends Binding.Service<
  ListSandboxesForProject,
  "AWS.CodeBuild.ListSandboxesForProject",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListSandboxesForProjectInput, "projectName">,
    ) => Effect.Effect<
      SVC.ListSandboxesForProjectOutput,
      SVC.ListSandboxesForProjectError
    >
  >
> {}
export const ListSandboxesForProject = Binding.Service<ListSandboxesForProject>(
  "AWS.CodeBuild.ListSandboxesForProject",
);
