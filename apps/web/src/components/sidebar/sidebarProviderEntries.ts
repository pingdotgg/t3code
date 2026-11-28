import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import {
  deriveProviderEntriesByEnvironment,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { environmentPresentations } from "../../state/presentation";

// The fields thread rows show. Provider status pushes refresh `checkedAt`,
// status and auth on every provider; leaving those out keeps each
// environment's map, and every memoized row, stable across them.
export type SidebarProviderEntry = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "enabled"
  | "displayName"
  | "accentColor"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "models"
>;

function sameSidebarProviderEntries(
  left: ReadonlyMap<string, SidebarProviderEntry>,
  right: ReadonlyMap<string, SidebarProviderEntry>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [instanceId, entry] of right) {
    const other = left.get(instanceId);
    if (
      other === undefined ||
      other.driverKind !== entry.driverKind ||
      other.enabled !== entry.enabled ||
      other.displayName !== entry.displayName ||
      other.accentColor !== entry.accentColor ||
      other.acpRegistryAgentId !== entry.acpRegistryAgentId ||
      other.acpRegistryIconUrl !== entry.acpRegistryIconUrl ||
      other.models !== entry.models
    ) {
      return false;
    }
  }
  return true;
}

// Resolve providers per environment because default instance ids collide across environments.
export const sidebarProviderEntriesAtom = Atom.make((get) => {
  const providersByEnvironment = get(environmentPresentations.providersByEnvironmentAtom);
  const derived = deriveProviderEntriesByEnvironment(
    [...get(environmentPresentations.serverConfigsAtom)].map(
      ([environmentId, config]) =>
        [environmentId, providersByEnvironment.get(environmentId) ?? [], config.settings] as const,
    ),
  );
  const previous = Option.getOrNull(
    get.self<ReadonlyMap<string, ReadonlyMap<string, SidebarProviderEntry>>>(),
  );
  const next = new Map<string, ReadonlyMap<string, SidebarProviderEntry>>();
  let changed = previous === null || previous.size !== derived.size;
  for (const [environmentId, entries] of derived) {
    const prior = previous?.get(environmentId);
    if (prior !== undefined && sameSidebarProviderEntries(prior, entries)) {
      next.set(environmentId, prior);
    } else {
      next.set(environmentId, entries);
      changed = true;
    }
  }
  return !changed && previous !== null ? previous : next;
}).pipe(Atom.withLabel("sidebar-provider-entries"));

export const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, SidebarProviderEntry> = new Map();
