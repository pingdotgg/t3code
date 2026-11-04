import { rankComposerModelMentions } from "@t3tools/client-runtime/composerModelMentions";
import type { ProviderInstanceId } from "@t3tools/contracts";

import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";

type ComposerModelItem = Extract<ComposerCommandItem, { type: "model" }>;

type ComposerModelMentionProvider = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "displayName"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "enabled"
  | "isAvailable"
  | "status"
>;

export function matchComposerModelItems(input: {
  readonly instanceEntries: ReadonlyArray<ComposerModelMentionProvider>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly query: string;
}): ComposerModelItem[] {
  const candidates: Array<{ entry: ComposerModelMentionProvider; option: ModelEsque }> = [];
  for (const entry of input.instanceEntries) {
    if (!isProviderInstancePickerReady(entry)) continue;
    for (const option of input.modelOptionsByInstance.get(entry.instanceId) ?? []) {
      // The picker hides legacy models by default; skip them so they don't fill the result cap.
      if (option.isLegacy || option.isUnavailable) continue;
      candidates.push({ entry, option });
    }
  }

  return rankComposerModelMentions(candidates, input.query, ({ entry, option }) => ({
    name: option.name,
    ...(option.shortName ? { shortName: option.shortName } : {}),
    ...(option.subProvider ? { subProvider: option.subProvider } : {}),
    driverKind: entry.driverKind,
    providerDisplayName: entry.displayName,
  })).map(({ entry, option }) => ({
    id: `model:${entry.instanceId}:${option.slug}`,
    type: "model",
    instanceId: entry.instanceId,
    model: option.slug,
    driverKind: entry.driverKind,
    providerDisplayName: entry.displayName,
    acpRegistryAgentId: entry.acpRegistryAgentId,
    acpRegistryIconUrl: entry.acpRegistryIconUrl,
    label: getDisplayModelName(option),
    description: option.subProvider ?? entry.displayName,
  }));
}
