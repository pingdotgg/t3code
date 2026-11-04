import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createMcpAppEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    callTool: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-apps:call-tool",
      tag: WS_METHODS.mcpAppsCallTool,
    }),
    toolInfo: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-apps:tool-info",
      tag: WS_METHODS.mcpAppsToolInfo,
    }),
    /** The tool definition an app reads from its host context. */
    toolInfoQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-apps:tool-info",
      tag: WS_METHODS.mcpAppsToolInfo,
    }),
    readResource: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-apps:read-resource",
      tag: WS_METHODS.mcpAppsReadResource,
    }),
    updateModelContext: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-apps:update-model-context",
      tag: WS_METHODS.mcpAppsUpdateModelContext,
    }),
  };
}
