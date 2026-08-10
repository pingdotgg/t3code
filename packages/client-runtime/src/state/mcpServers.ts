import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

export function createMcpServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-servers:list",
      tag: WS_METHODS.mcpServersList,
    }),
    upsert: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp-servers:upsert",
      tag: WS_METHODS.mcpServersUpsert,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp-servers:remove",
      tag: WS_METHODS.mcpServersRemove,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    testConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp-servers:test-connection",
      tag: WS_METHODS.mcpServersTestConnection,
    }),
  };
}
