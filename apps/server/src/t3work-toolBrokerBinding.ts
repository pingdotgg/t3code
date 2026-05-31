import type { ThreadId } from "@t3tools/contracts";
import { PROJECT_RECIPE_TOOL_GROUP_BY_TOOL_ID } from "@t3tools/project-recipes";
import * as Effect from "effect/Effect";

import {
  T3WORK_CURRENT_VIEW_RESOURCE_URI,
  T3WORK_MCP_SERVER_NAME,
  type T3workPrelaunchToolBinding,
  type T3workToolBinding,
} from "./t3work-toolBroker.ts";
import {
  TOOL_SPECS,
  errorResult,
  foldResource,
  foldResult,
  okResult,
  readBacklogAssigneeFilterMode,
  resourceResult,
} from "./t3work-toolBrokerHelpers.ts";
import { buildBindingState, permissionMessage } from "./t3work-toolBrokerBindingPermissions.ts";
import { callT3workRenameTool } from "./t3work-toolBrokerBindingRename.ts";

type CreateBindingInput<
  TRenameError = never,
  TStartChildError = never,
  TReadError = never,
  TBacklogAssigneeFilterError = never,
> = {
  readonly availableToolIds: ReadonlyArray<string>;
  readonly allowedToolGroups?: ReadonlyArray<string> | undefined;
  readonly scopeLabel: string;
  readonly prelaunchOnly?: boolean;
  readonly readView: () => Effect.Effect<unknown, TReadError>;
  readonly renameThread?: (title: string) => Effect.Effect<unknown, TRenameError>;
  readonly renameThreadResult?: (title: string) => unknown;
  readonly startChild?: (arguments_: unknown) => Effect.Effect<unknown, TStartChildError>;
  readonly setBacklogAssigneeFilter?: (
    mode: "current-user",
  ) => Effect.Effect<unknown, TBacklogAssigneeFilterError>;
};

function createToolSurface<TRenameError, TStartChildError, TReadError, TBacklogAssigneeFilterError>(
  input: CreateBindingInput<
    TRenameError,
    TStartChildError,
    TReadError,
    TBacklogAssigneeFilterError
  >,
) {
  const state = buildBindingState({
    availableToolIds: input.availableToolIds,
    ...(input.allowedToolGroups ? { allowedToolGroups: input.allowedToolGroups } : {}),
    ...(input.prelaunchOnly ? { prelaunchOnly: true } : {}),
  });

  const callTool: T3workToolBinding["callTool"] = ({ server, tool, arguments: toolArgs }) => {
    if (server !== T3WORK_MCP_SERVER_NAME) {
      return Effect.succeed(errorResult(`Unknown MCP server '${server}'.`));
    }
    if (!state.availableToolIdSet.has(tool)) {
      return Effect.succeed(errorResult(`Tool '${tool}' is not enabled ${input.scopeLabel}.`));
    }
    if (state.effectiveGroups && !state.allowedToolIdSet.has(tool)) {
      return Effect.succeed(errorResult(permissionMessage(tool, state.effectiveGroups)));
    }
    if (tool === "t3work.thread.rename") {
      return callT3workRenameTool({
        tool,
        scopeLabel: input.scopeLabel,
        toolArgs,
        ...(input.renameThread ? { renameThread: input.renameThread } : {}),
        ...(input.renameThreadResult ? { renameThreadResult: input.renameThreadResult } : {}),
      });
    }
    if (tool === "t3work.thread.start_child") {
      if (!input.startChild) {
        return Effect.succeed(errorResult(`Tool '${tool}' is not enabled ${input.scopeLabel}.`));
      }
      return foldResult(input.startChild(toolArgs), okResult, (message) =>
        errorResult(`Failed to start child session: ${message}`),
      );
    }
    if (tool === "t3work.backlog.set_assignee_filter") {
      if (!input.setBacklogAssigneeFilter) {
        return Effect.succeed(errorResult(`Tool '${tool}' is not enabled ${input.scopeLabel}.`));
      }
      const mode = readBacklogAssigneeFilterMode(toolArgs);
      if (!mode) {
        return Effect.succeed(
          errorResult("t3work.backlog.set_assignee_filter requires mode: 'current-user'."),
        );
      }
      return foldResult(input.setBacklogAssigneeFilter(mode), okResult, (message) =>
        errorResult(`Failed to update backlog assignee filter: ${message}`),
      );
    }
    if (tool !== "t3work.view.read") {
      return Effect.succeed(errorResult(`Tool '${tool}' is not implemented in this runtime.`));
    }
    return foldResult(input.readView(), okResult, (message) =>
      errorResult(`Failed to read t3work view: ${message}`),
    );
  };

  const readResource: T3workToolBinding["readResource"] = ({ server, uri }) => {
    if (server !== T3WORK_MCP_SERVER_NAME) {
      return Effect.succeed(resourceResult(uri, { error: `Unknown MCP server '${server}'.` }));
    }
    if (uri !== T3WORK_CURRENT_VIEW_RESOURCE_URI) {
      return Effect.succeed(resourceResult(uri, { error: `Resource '${uri}' is not available.` }));
    }
    if (!state.availableToolIdSet.has("t3work.view.read")) {
      return Effect.succeed(resourceResult(uri, { error: `Resource '${uri}' is not available.` }));
    }
    if (state.effectiveGroups && !state.allowedToolIdSet.has("t3work.view.read")) {
      return Effect.succeed(
        resourceResult(uri, {
          error: permissionMessage("t3work.view.read", state.effectiveGroups),
        }),
      );
    }
    return foldResource(input.readView(), uri, (value) => resourceResult(uri, value));
  };

  return {
    listServers: () => [
      {
        authStatus: "unsupported" as const,
        name: T3WORK_MCP_SERVER_NAME,
        resourceTemplates: [],
        resources: state.allowedToolIdSet.has("t3work.view.read")
          ? [
              {
                uri: T3WORK_CURRENT_VIEW_RESOURCE_URI,
                name: "Current t3work view",
                mimeType: "application/json",
                description: "Latest thread and project context for this t3work view.",
              },
            ]
          : [],
        tools: Object.fromEntries(
          state.allowedToolIds.flatMap((toolId) => {
            const spec = TOOL_SPECS[toolId as keyof typeof TOOL_SPECS];
            return spec ? [[toolId, spec] as const] : [];
          }),
        ),
      },
    ],
    callTool,
    readResource,
  };
}

export function createT3workThreadToolBinding<
  TRenameError,
  TStartChildError,
  TReadError,
  TBacklogAssigneeFilterError,
>(
  input: Omit<
    CreateBindingInput<TRenameError, TStartChildError, TReadError, TBacklogAssigneeFilterError>,
    "scopeLabel" | "prelaunchOnly"
  > & {
    readonly threadId: ThreadId;
  },
): T3workToolBinding {
  return {
    threadId: input.threadId,
    ...createToolSurface({ ...input, scopeLabel: "for this thread." }),
  };
}

export function createT3workPrelaunchToolBinding<
  TRenameError,
  TStartChildError,
  TReadError,
  TBacklogAssigneeFilterError,
>(
  input: Omit<
    CreateBindingInput<TRenameError, TStartChildError, TReadError, TBacklogAssigneeFilterError>,
    "availableToolIds" | "prelaunchOnly" | "scopeLabel"
  > & {
    readonly workspaceRoot: string;
    readonly callerKind: "visibility" | "view.preRender";
  },
): T3workPrelaunchToolBinding {
  return {
    bindingKey: `${input.callerKind}:${input.workspaceRoot}`,
    ...createToolSurface({
      ...input,
      availableToolIds: Object.keys(PROJECT_RECIPE_TOOL_GROUP_BY_TOOL_ID),
      prelaunchOnly: true,
      scopeLabel: `during ${input.callerKind} evaluation.`,
    }),
  };
}
