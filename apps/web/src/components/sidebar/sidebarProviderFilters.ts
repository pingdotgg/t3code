import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ProviderDriverKind,
  type ServerConfig,
} from "@t3tools/contracts";

import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { sidebarProviderInstanceKey } from "../Sidebar.logic";
import type { SidebarFilterProviderOption } from "./SidebarFilterMenu";

export { sidebarProviderInstanceKey } from "../Sidebar.logic";

export interface SidebarProviderFilterState {
  readonly entryByScopedInstanceKey: ReadonlyMap<string, ProviderInstanceEntry>;
  readonly driverKindByScopedInstanceKey: ReadonlyMap<string, ProviderDriverKind>;
  readonly sources: ReadonlyArray<SidebarFilterProviderOption>;
}

export function buildSidebarProviderFilterState(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): SidebarProviderFilterState {
  const entryByScopedInstanceKey = new Map<string, ProviderInstanceEntry>();
  const driverKindByScopedInstanceKey = new Map<string, ProviderDriverKind>();
  const labelsByDriverKind = new Map<ProviderDriverKind, string>();

  for (const [environmentId, config] of serverConfigs) {
    for (const entry of deriveProviderInstanceEntries(config.providers)) {
      const key = sidebarProviderInstanceKey(environmentId, entry.instanceId);
      entryByScopedInstanceKey.set(key, entry);
      driverKindByScopedInstanceKey.set(key, entry.driverKind);
      if (!labelsByDriverKind.has(entry.driverKind)) {
        labelsByDriverKind.set(
          entry.driverKind,
          PROVIDER_DISPLAY_NAMES[entry.driverKind] ?? entry.displayName,
        );
      }
    }
  }

  return {
    entryByScopedInstanceKey,
    driverKindByScopedInstanceKey,
    sources: [...labelsByDriverKind].map(([driverKind, label]) => ({ driverKind, label })),
  };
}
