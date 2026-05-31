import * as Effect from "effect/Effect";

import type { T3workToolCallResult } from "./t3work-toolBroker.ts";
import { errorResult, foldResult, okResult } from "./t3work-toolBrokerHelpers.ts";
import {
  executeWorkflowSdkThreadRename,
  WorkflowSdkBridgeError,
} from "./t3work-workflowSdkToolBridge.ts";

export function callT3workRenameTool<TRenameError>(input: {
  readonly tool: string;
  readonly scopeLabel: string;
  readonly toolArgs: unknown;
  readonly renameThread?: (title: string) => Effect.Effect<unknown, TRenameError>;
  readonly renameThreadResult?: (title: string) => unknown;
}): Effect.Effect<T3workToolCallResult, never> {
  if (!input.renameThread) {
    return Effect.succeed(errorResult(`Tool '${input.tool}' is not enabled ${input.scopeLabel}.`));
  }

  const renameThread = input.renameThread;
  return foldResult(
    executeWorkflowSdkThreadRename({
      toolArgs: input.toolArgs,
      renameThread: (title) =>
        renameThread(title).pipe(
          Effect.mapError(
            (error) =>
              new WorkflowSdkBridgeError({
                message: error instanceof Error ? error.message : String(error),
                cause: error,
              }),
          ),
        ),
      ...(input.renameThreadResult ? { renameThreadResult: input.renameThreadResult } : {}),
    }),
    okResult,
    (message) =>
      errorResult(
        message.startsWith("t3work.thread.rename requires")
          ? message
          : `Failed to rename thread: ${message}`,
      ),
  );
}
