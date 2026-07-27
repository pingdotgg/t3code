import type * as SVC from "@distilled.cloud/aws/codebuild";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:BatchGetCommandExecutions` — reads the
 * status and output of sandbox command executions of the bound project.
 * @binding
 * @section Sandboxes
 * @example Poll a Command Execution
 * ```typescript
 * const batchGetCommandExecutions = yield* AWS.CodeBuild.BatchGetCommandExecutions(project);
 *
 * const { commandExecutions } = yield* batchGetCommandExecutions({
 *   sandboxId,
 *   commandExecutionIds: [commandId],
 * });
 * ```
 */
export interface BatchGetCommandExecutions extends Binding.Service<
  BatchGetCommandExecutions,
  "AWS.CodeBuild.BatchGetCommandExecutions",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.BatchGetCommandExecutionsInput,
    ) => Effect.Effect<
      SVC.BatchGetCommandExecutionsOutput,
      SVC.BatchGetCommandExecutionsError
    >
  >
> {}
export const BatchGetCommandExecutions =
  Binding.Service<BatchGetCommandExecutions>(
    "AWS.CodeBuild.BatchGetCommandExecutions",
  );
