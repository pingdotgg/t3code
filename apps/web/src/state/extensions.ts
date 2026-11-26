// Fork: Kaluwa's Extensions page.
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  selectEnvironmentQueryData,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ExtensionsListResult, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import {
  forgetMcpHealth,
  listNeedsAttention,
  mergeExtensionLists,
  mutationStaleMcpHealth,
} from "../components/extensions/extensionsModel";
import { connectionAtomRuntime } from "../connection/runtime";

/** The last list that checked MCP health, kept so fast refreshes still show it. */
const checkedListAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<ExtensionsListResult | null>(null).pipe(Atom.keepAlive),
);

const extensionsList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:extensions:list",
  tag: WS_METHODS.extensionsList,
  staleTimeMs: 60_000,
  idleTtlMs: 10 * 60_000,
  onAnswer: (target, value, registry) =>
    Effect.sync(() => {
      if (value.healthChecked) registry.set(checkedListAtom(target.environmentId), value);
    }),
});

export const extensionsFastListAtom = (environmentId: EnvironmentId) =>
  extensionsList({ environmentId, input: { checkHealth: false } });

/** Starts a health check when read; the page reads it, the nav rail does not. */
export const extensionsHealthCheckAtom = (environmentId: EnvironmentId) =>
  extensionsList({ environmentId, input: { checkHealth: true } });

/** The fast list with the last known MCP health filled in. Reading it never checks health. */
export const extensionsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    mergeExtensionLists(
      selectEnvironmentQueryData(get(extensionsFastListAtom(environmentId))),
      get(checkedListAtom(environmentId)),
    ),
  ),
);

export const extensionsNeedAttentionAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) =>
    // Only what the page already loaded: the rail never starts the provider CLIs itself.
    environmentId === null ? false : listNeedsAttention(get(checkedListAtom(environmentId))),
  ),
);

export const extensionsMutate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:extensions:mutate",
  tag: WS_METHODS.extensionsMutate,
  onSuccess: (target, registry) =>
    Effect.sync(() => {
      const stale = mutationStaleMcpHealth(target.input);
      const checked = registry.get(checkedListAtom(target.environmentId));
      if (stale !== null && checked !== null) {
        registry.set(
          checkedListAtom(target.environmentId),
          forgetMcpHealth(checked, stale.instanceIds, stale.name),
        );
      }
      registry.refresh(extensionsFastListAtom(target.environmentId));
      // Only a new check can say how a server that was added, signed in or switched is doing.
      if (stale !== null) registry.refresh(extensionsHealthCheckAtom(target.environmentId));
    }),
});
