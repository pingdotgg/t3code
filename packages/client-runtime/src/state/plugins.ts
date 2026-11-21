import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Both clients manage plugins through their selected environment's authenticated RPC session. */
export function createEnvironmentPluginAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };
  const snapshot = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:plugins:snapshot",
    tag: WS_METHODS.pluginsSubscribe,
    idleTtlMs: 0,
  });
  return {
    snapshot,
    snapshotAtom: (environmentId: EnvironmentId) => snapshot({ environmentId, input: {} }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:plugins:list",
      tag: WS_METHODS.pluginsList,
      staleTimeMs: 0,
    }),
    catalog: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:plugins:catalog",
      tag: WS_METHODS.pluginsRegistryList,
      staleTimeMs: 0,
    }),
    install: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:install",
      tag: WS_METHODS.pluginsRegistryInstall,
      scheduler,
      concurrency,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:set-enabled",
      tag: WS_METHODS.pluginsSetEnabled,
      scheduler,
      concurrency,
    }),
    reload: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:reload",
      tag: WS_METHODS.pluginsReload,
      scheduler,
      concurrency,
    }),
    invoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:invoke",
      tag: WS_METHODS.pluginsInvoke,
    }),
  };
}
