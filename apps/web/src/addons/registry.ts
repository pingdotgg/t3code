import type { ComposerAddon } from "./composer";
import type { SidebarAddon } from "./sidebar";

export interface WebAddon {
  readonly id: string;
  readonly composer?: ComposerAddon;
  readonly sidebar?: SidebarAddon;
}

interface WebAddonModule {
  readonly default: WebAddon;
}

const discoveredModules = import.meta.glob<WebAddonModule>("./bundled/*/index.ts", {
  eager: true,
});

export function validateWebAddons(addons: readonly WebAddon[]): readonly WebAddon[] {
  const seen = new Set<string>();
  for (const addon of addons) {
    if (!/^[a-z][a-z0-9-]*$/.test(addon.id)) {
      throw new Error(`Invalid addon id: ${addon.id}`);
    }
    if (seen.has(addon.id)) {
      throw new Error(`Duplicate addon id: ${addon.id}`);
    }
    seen.add(addon.id);
  }
  return addons;
}

/** Build-time discovery keeps arbitrary third-party code out of the runtime. */
export const bundledWebAddons = validateWebAddons(
  Object.entries(discoveredModules)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, module]) => module.default),
);
