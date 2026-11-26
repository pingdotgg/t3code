import { WS_METHODS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const noToolGrants: ReadonlyArray<string> = [];
const toolGrantsAtom = Atom.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map()).pipe(
  Atom.keepAlive,
);
const toolGrantsByPreview = Atom.family((key: string) => {
  const atom = Atom.make((get) => get(toolGrantsAtom).get(key) ?? noToolGrants);
  return {
    atom,
    allow: (registry: AtomRegistry.AtomRegistry, name: string) => {
      const names = registry.get(atom);
      if (names.includes(name)) return;
      const next = new Map(registry.get(toolGrantsAtom));
      next.set(key, [...names, name]);
      registry.set(toolGrantsAtom, next);
    },
    revoke: (registry: AtomRegistry.AtomRegistry) => {
      const next = new Map(registry.get(toolGrantsAtom));
      if (next.delete(key)) registry.set(toolGrantsAtom, next);
    },
  };
});

export function mcpAppToolGrants(input: {
  readonly environmentId: EnvironmentId;
  readonly conversationThreadId: ThreadId;
  readonly app: { readonly attachmentId: string; readonly server: string };
}) {
  return toolGrantsByPreview(
    JSON.stringify([
      input.environmentId,
      input.conversationThreadId,
      input.app.attachmentId,
      input.app.server,
    ]),
  );
}

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
