import { WorkspaceBridgeError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  WorkspaceBridgeCoordinator,
  WorkspaceBridgeCoordinatorLive,
} from "./WorkspaceBridgeCoordinator.ts";
import { WorkspaceToolkit } from "./tools.ts";

/**
 * Gates every workspace tool on the `workspace` capability.
 *
 * The check is per-call rather than per-connection on purpose: capabilities
 * live on the credential, and a credential can be revoked mid-conversation
 * (thread archived, session ended). Re-checking means a revoked connector
 * stops working on its next call instead of for the life of the MCP session.
 */
const requireWorkspaceScope = Effect.fn("WorkspaceToolkit.requireWorkspaceScope")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("workspace")) {
    return yield* new WorkspaceBridgeError({
      reason: "capability-unavailable",
      description: "This MCP credential does not grant the workspace capability.",
    });
  }
  return invocation;
});

const WorkspaceToolkitHandlers = WorkspaceToolkit.toLayer({
  workspace_overview: () =>
    Effect.gen(function* () {
      const scope = yield* requireWorkspaceScope();
      return yield* (yield* WorkspaceBridgeCoordinator).overview(scope);
    }),
  workspace_tree: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireWorkspaceScope();
      return yield* (yield* WorkspaceBridgeCoordinator).tree(scope, input);
    }),
  workspace_read: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireWorkspaceScope();
      return yield* (yield* WorkspaceBridgeCoordinator).read(scope, input);
    }),
  workspace_search: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireWorkspaceScope();
      return yield* (yield* WorkspaceBridgeCoordinator).search(scope, input);
    }),
  workspace_changes: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireWorkspaceScope();
      return yield* (yield* WorkspaceBridgeCoordinator).changes(scope, input);
    }),
});

export const WorkspaceToolkitHandlersLive = WorkspaceToolkitHandlers.pipe(
  Layer.provide(WorkspaceBridgeCoordinatorLive),
);
