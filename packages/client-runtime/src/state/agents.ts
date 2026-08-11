import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** Shared web/mobile read model for the environment and project Agent catalog. */
export function createAgentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    catalog: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agents:catalog",
      tag: WS_METHODS.agentsCatalog,
      staleTimeMs: 5_000,
    }),
    profile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agents:profile",
      tag: WS_METHODS.agentsGetProfile,
      staleTimeMs: 5_000,
    }),
    rule: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agents:rule",
      tag: WS_METHODS.agentsGetRule,
      staleTimeMs: 5_000,
    }),
    saveProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:save-profile",
      tag: WS_METHODS.agentsSaveProfile,
      scheduler: commandScheduler,
      concurrency,
    }),
    archiveProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:archive-profile",
      tag: WS_METHODS.agentsArchiveProfile,
      scheduler: commandScheduler,
      concurrency,
    }),
    restoreProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:restore-profile",
      tag: WS_METHODS.agentsRestoreProfile,
      scheduler: commandScheduler,
      concurrency,
    }),
    saveRule: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:save-rule",
      tag: WS_METHODS.agentsSaveRule,
      scheduler: commandScheduler,
      concurrency,
    }),
    archiveRule: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:archive-rule",
      tag: WS_METHODS.agentsArchiveRule,
      scheduler: commandScheduler,
      concurrency,
    }),
    restoreRule: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:restore-rule",
      tag: WS_METHODS.agentsRestoreRule,
      scheduler: commandScheduler,
      concurrency,
    }),
  };
}
