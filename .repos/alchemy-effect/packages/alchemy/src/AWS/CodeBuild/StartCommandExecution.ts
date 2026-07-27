import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:StartCommandExecution` — runs a shell
 * command in a running sandbox of the bound project. Poll the result with
 * {@link BatchGetCommandExecutions}.
 * @binding
 * @section Sandboxes
 * @example Run a Command in a Sandbox
 * ```typescript
 * const startCommandExecution = yield* AWS.CodeBuild.StartCommandExecution(project);
 *
 * const { commandExecution } = yield* startCommandExecution({
 *   sandboxId,
 *   command: "echo hello",
 * });
 * ```
 */
export interface StartCommandExecution extends Binding.Service<
  StartCommandExecution,
  "AWS.CodeBuild.StartCommandExecution",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.StartCommandExecutionInput,
    ) => Effect.Effect<
      SVC.StartCommandExecutionOutput,
      SVC.StartCommandExecutionError
    >
  >
> {}
export const StartCommandExecution = Binding.Service<StartCommandExecution>(
  "AWS.CodeBuild.StartCommandExecution",
);
