import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:BatchGetSandboxes` — reads the status of
 * one or more sandboxes of the bound project by sandbox id.
 * @binding
 * @section Sandboxes
 * @example Poll a Sandbox
 * ```typescript
 * const batchGetSandboxes = yield* AWS.CodeBuild.BatchGetSandboxes(project);
 *
 * const { sandboxes } = yield* batchGetSandboxes({ ids: [sandboxId] });
 * ```
 */
export interface BatchGetSandboxes extends Binding.Service<
  BatchGetSandboxes,
  "AWS.CodeBuild.BatchGetSandboxes",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.BatchGetSandboxesInput,
    ) => Effect.Effect<SVC.BatchGetSandboxesOutput, SVC.BatchGetSandboxesError>
  >
> {}
export const BatchGetSandboxes = Binding.Service<BatchGetSandboxes>(
  "AWS.CodeBuild.BatchGetSandboxes",
);
