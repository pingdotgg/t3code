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

/** Shows a notice once however many instances raise it, listing the ones the caller named. */
export function groupUpdateRequiredNotices(
  notices: ReadonlyArray<{ readonly notice: string; readonly instanceName?: string | undefined }>,
): ReadonlyArray<{ readonly notice: string; readonly instanceNames: ReadonlyArray<string> }> {
  const namesByNotice = new Map<string, string[]>();
  for (const { notice, instanceName } of notices) {
    const names = namesByNotice.get(notice) ?? [];
    if (instanceName) names.push(instanceName);
    namesByNotice.set(notice, names);
  }
  return Array.from(namesByNotice, ([notice, instanceNames]) => ({ notice, instanceNames }));
}
