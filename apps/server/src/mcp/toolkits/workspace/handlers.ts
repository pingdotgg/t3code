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
 * Gates every workspace tool on the capability it needs.
 *
 * The check is per-call rather than per-connection on purpose: capabilities
 * live on the credential, and a credential can be revoked mid-conversation
 * (thread archived, session ended). Re-checking means a revoked connector
 * stops working on its next call instead of for the life of the MCP session.
 *
 * The coordinator re-checks write/bash itself before staging — the handler
 * gate is the polite refusal with a good message, the coordinator gate is the
 * one a bug in this file cannot remove.
 */
const requireCapability = (capability: "workspace" | "workspace-write" | "workspace-bash") =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has(capability)) {
      return yield* new WorkspaceBridgeError({
        reason: "capability-unavailable",
        description:
          capability === "workspace"
            ? "This MCP credential does not grant the workspace capability."
            : `This connector was issued without ${capability === "workspace-bash" ? "shell" : "write"} access. The user can raise "Workspace access" in SergeCode's ChatGPT provider settings and start a new thread.`,
      });
    }
    return invocation;
  });

const WorkspaceToolkitHandlers = WorkspaceToolkit.toLayer({
  workspace_overview: () =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("workspace");
      return yield* (yield* WorkspaceBridgeCoordinator).overview(scope);
    }),
  workspace_tree: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("workspace");
      return yield* (yield* WorkspaceBridgeCoordinator).tree(scope, input);
    }),
  workspace_read: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("workspace");
      return yield* (yield* WorkspaceBridgeCoordinator).read(scope, input);
    }),
  workspace_search: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("workspace");
      return yield* (yield* WorkspaceBridgeCoordinator).search(scope, input);
    }),
  workspace_changes: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("workspace");
      return yield* (yield* WorkspaceBridgeCoordinator).changes(scope, input);
    }),
  workspace_write: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("workspace-write");
      return yield* (yield* WorkspaceBridgeCoordinator).write(scope, input);
    }),
  workspace_edit: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("workspace-write");
      return yield* (yield* WorkspaceBridgeCoordinator).edit(scope, input);
    }),
  workspace_patch: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("workspace-write");
      return yield* (yield* WorkspaceBridgeCoordinator).patch(scope, input);
    }),
  workspace_bash: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("workspace-bash");
      return yield* (yield* WorkspaceBridgeCoordinator).bash(scope, input);
    }),
  workspace_wait: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("workspace");
      return yield* (yield* WorkspaceBridgeCoordinator).wait(scope, input);
    }),
});

export const WorkspaceToolkitHandlersLive = WorkspaceToolkitHandlers.pipe(
  Layer.provide(WorkspaceBridgeCoordinatorLive),
);
