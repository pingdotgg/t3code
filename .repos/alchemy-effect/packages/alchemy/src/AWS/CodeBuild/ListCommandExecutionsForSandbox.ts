import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:ListCommandExecutionsForSandbox` — lists
 * the command executions run in a sandbox of the bound project.
 * @binding
 * @section Sandboxes
 * @example List Command Executions
 * ```typescript
 * const listCommandExecutions = yield* AWS.CodeBuild.ListCommandExecutionsForSandbox(project);
 *
 * const { commandExecutions } = yield* listCommandExecutions({ sandboxId });
 * ```
 */
export interface ListCommandExecutionsForSandbox extends Binding.Service<
  ListCommandExecutionsForSandbox,
  "AWS.CodeBuild.ListCommandExecutionsForSandbox",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.ListCommandExecutionsForSandboxInput,
    ) => Effect.Effect<
      SVC.ListCommandExecutionsForSandboxOutput,
      SVC.ListCommandExecutionsForSandboxError
    >
  >
> {}
export const ListCommandExecutionsForSandbox =
  Binding.Service<ListCommandExecutionsForSandbox>(
    "AWS.CodeBuild.ListCommandExecutionsForSandbox",
  );
