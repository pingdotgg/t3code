import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createPluginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const catalog = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:plugins:catalog",
    tag: WS_METHODS.pluginsList,
    // The catalog only changes on explicit create/enable/disable (which refresh it) or
    // via the manual Reload button, so use a comfortable stale window instead of a tiny
    // 5s override that forced a full server directory re-scan on nearly every remount.
    staleTimeMs: 5 * 60_000,
  });
  const refreshCatalog = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.refresh(catalog({ environmentId: target.environmentId, input: {} })),
    );
  const mutationOptions = {
    scheduler: commandScheduler,
    concurrency: {
      mode: "serial" as const,
      key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
    },
    onSuccess: refreshCatalog,
  };

  return {
    catalog,
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:create",
      tag: WS_METHODS.pluginsCreate,
      ...mutationOptions,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:set-enabled",
      tag: WS_METHODS.pluginsSetEnabled,
      ...mutationOptions,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:delete",
      tag: WS_METHODS.pluginsDelete,
      ...mutationOptions,
    }),
    addSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:add-source",
      tag: WS_METHODS.pluginsAddSource,
      ...mutationOptions,
    }),
    updateSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:update-source",
      tag: WS_METHODS.pluginsUpdateSource,
      ...mutationOptions,
    }),
    removeSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:remove-source",
      tag: WS_METHODS.pluginsRemoveSource,
      ...mutationOptions,
    }),
    createViewUrl: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:plugins:create-view-url",
      tag: WS_METHODS.pluginsCreateViewUrl,
      // No periodic re-issuing: each execution mints a new token, and the host snapshots
      // the first resolved URL per mount. The token TTL (60 min) plus mount/explicit-reload
      // re-issue is enough, so the aggressive 30-min refresh interval is removed to avoid
      // silently hard-navigating the plugin iframe and wiping its in-frame state.
      staleTimeMs: 5 * 60_000,
    }),
    invoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugins:invoke",
      tag: WS_METHODS.pluginsInvoke,
      scheduler: commandScheduler,
      concurrency: { mode: "parallel" },
    }),
  };
}
