import type { ProviderDriverKind } from "@t3tools/contracts";

import type { ModelEsque } from "./providerIconUtils";

/** Keeps a hidden model visible while its provider is locked or turned off. */
export function retainedModelWhileProviderLocked(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
    readonly models: ReadonlyArray<Pick<ModelEsque, "slug" | "name" | "shortName" | "subProvider">>;
  } | null,
  model: string,
): ModelEsque | undefined {
  if (!entry || (entry.enabled && entry.isAvailable) || !model) return undefined;
  if (entry.driverKind === "opencode" || entry.driverKind === "antigravity") return undefined;
  return entry.models.find((candidate) => candidate.slug === model) ?? { slug: model, name: model };
}

/**
 * Shows a notice once however many instances raise it. When any of them is `named`, the notice
 * lists every instance that raised it, so it never names only some of the ones it covers.
 */
export function groupUpdateRequiredNotices(
  notices: ReadonlyArray<{
    readonly notice: string;
    readonly instanceName: string;
    readonly named: boolean;
  }>,
): ReadonlyArray<{ readonly notice: string; readonly instanceNames: ReadonlyArray<string> }> {
  const groups = new Map<string, { readonly names: string[]; named: boolean }>();
  for (const { notice, instanceName, named } of notices) {
    const group = groups.get(notice) ?? { names: [], named: false };
    group.names.push(instanceName);
    group.named ||= named;
    groups.set(notice, group);
  }
  return Array.from(groups, ([notice, { names, named }]) => ({
    notice,
    instanceNames: named ? names : [],
  }));
}
