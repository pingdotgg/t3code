// Fork: the provider logo a titlebar tab shows. Provider status pushes replace the provider lists
// often; the atom keeps its previous value until a field a tab draws changes.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import {
  deriveProviderEntriesByEnvironment,
  shouldShowInstanceBadge,
} from "../../providerInstances";
import { environmentPresentations } from "../../state/presentation";
import type { SidebarProviderEntry } from "../sidebar/SidebarThreadRow";

type ThreadTabProvider = Readonly<{ entry: SidebarProviderEntry; showBadge: boolean }>;

function sameProvider(left: ThreadTabProvider | null, right: ThreadTabProvider | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.showBadge === right.showBadge &&
    left.entry.driverKind === right.entry.driverKind &&
    left.entry.displayName === right.entry.displayName &&
    left.entry.accentColor === right.entry.accentColor &&
    left.entry.acpRegistryAgentId === right.entry.acpRegistryAgentId &&
    left.entry.acpRegistryIconUrl === right.entry.acpRegistryIconUrl
  );
}

const NO_PROVIDER_ATOM = Atom.make<ThreadTabProvider | null>(null);

const threadTabProviderAtom = Atom.family((key: string) =>
  Atom.make((get): ThreadTabProvider | null => {
    const separator = key.indexOf("\u0000");
    const environmentId = key.slice(0, separator) as EnvironmentId;
    const instanceId = key.slice(separator + 1);
    const config = get(environmentPresentations.serverConfigsAtom).get(environmentId);
    const providers = get(environmentPresentations.providersByEnvironmentAtom).get(environmentId);
    const entries =
      deriveProviderEntriesByEnvironment([
        config
          ? ([environmentId, providers ?? [], config.settings] as const)
          : ([environmentId, providers ?? []] as const),
      ]).get(environmentId) ?? new Map();
    const entry = entries.get(instanceId);
    const next = entry
      ? { entry, showBadge: shouldShowInstanceBadge(entry, entries.values()) }
      : null;
    const previous = Option.getOrNull(get.self<ThreadTabProvider | null>());
    return previous !== null && sameProvider(previous, next) ? previous : next;
  }),
);

export function useThreadTabProvider(
  environmentId: EnvironmentId | null,
  instanceId: string | null,
): ThreadTabProvider | null {
  return useAtomValue(
    environmentId === null || instanceId === null
      ? NO_PROVIDER_ATOM
      : threadTabProviderAtom(`${environmentId}\u0000${instanceId}`),
  );
}
