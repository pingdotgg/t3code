import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import {
  executeRegisteredTool,
  type FetchLike,
  type ToolHandlerCtx,
  type ToolRef,
  type ToolWorkspace,
} from "@t3work/sdk";
import { renameThreadTool, type RenameThreadToolResult } from "@t3work/sdk/tools/t3work";

export class WorkflowSdkBridgeError extends Data.TaggedError("WorkflowSdkBridgeError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const unsupportedFetch: FetchLike = async () => {
  throw new Error("Fetch is not wired in this workflow-sdk bridge.");
};

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as const;

const unsupportedWorkspace: ToolWorkspace = {
  readText: async () => {
    throw new Error("Workspace reads are not wired in this workflow-sdk bridge.");
  },
  writeText: async () => {
    throw new Error("Workspace writes are not wired in this workflow-sdk bridge.");
  },
  exists: async () => false,
};

const unsupportedCallTool: ToolHandlerCtx["callTool"] = async <I, R>(
  _ref: ToolRef<I, R>,
  _args: I,
): Promise<R> => {
  throw new Error("Cross-tool workflow-sdk dispatch is not wired in this runtime.");
};

function toWorkflowSdkBridgeError(error: unknown): WorkflowSdkBridgeError {
  return new WorkflowSdkBridgeError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

export function executeWorkflowSdkThreadRename(input: {
  readonly toolArgs: unknown;
  readonly renameThread: (title: string) => Effect.Effect<unknown, WorkflowSdkBridgeError>;
  readonly renameThreadResult?: (title: string) => unknown;
}): Effect.Effect<RenameThreadToolResult, WorkflowSdkBridgeError> {
  return Effect.tryPromise({
    try: () =>
      executeRegisteredTool(renameThreadTool.id, input.toolArgs, {
        workspaceRoot: "",
        log: noopLog,
        fetch: unsupportedFetch,
        workspace: unsupportedWorkspace,
        callTool: unsupportedCallTool,
        t3work: {
          renameThread: async ({ title }) => {
            await Effect.runPromise(input.renameThread(title));
            const result = input.renameThreadResult
              ? input.renameThreadResult(title)
              : { ok: true as const, title };
            return result as RenameThreadToolResult;
          },
        },
      }) as Promise<RenameThreadToolResult>,
    catch: toWorkflowSdkBridgeError,
  });
}
