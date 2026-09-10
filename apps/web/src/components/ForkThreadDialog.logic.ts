import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

import type { ModelEsque } from "./chat/providerIconUtils";
import type { ProviderInstanceEntry } from "../providerInstances";

export function isSameForkModelSelection(
  left: Pick<ModelSelection, "instanceId" | "model">,
  right: Pick<ModelSelection, "instanceId" | "model">,
): boolean {
  return left.instanceId === right.instanceId && left.model === right.model;
}

export function isForkModelSelectionReady(input: {
  readonly selection: Pick<ModelSelection, "instanceId" | "model">;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
}): boolean {
  const entry = input.entries.find(
    (candidate) => candidate.instanceId === input.selection.instanceId,
  );
  if (!entry?.enabled || !entry.isAvailable || entry.status !== "ready") return false;
  return (input.modelOptionsByInstance.get(entry.instanceId) ?? []).some(
    (model) => model.slug === input.selection.model && !model.isUnavailable,
  );
}

export function findInitialForkModelSelection(input: {
  readonly source: Pick<ModelSelection, "instanceId" | "model">;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
}): ModelSelection | null {
  for (const preferDifferentInstance of [true, false]) {
    for (const entry of input.entries) {
      if (!entry.enabled || !entry.isAvailable || entry.status !== "ready") continue;
      if (preferDifferentInstance !== (entry.instanceId !== input.source.instanceId)) continue;
      for (const model of input.modelOptionsByInstance.get(entry.instanceId) ?? []) {
        const selection = { instanceId: entry.instanceId, model: model.slug };
        if (!model.isUnavailable && !isSameForkModelSelection(selection, input.source))
          return selection;
      }
    }
  }
  return null;
}
