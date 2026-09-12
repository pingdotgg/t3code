import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ModelEsque } from "./providerIconUtils";

/** One entry per account opens the pairing editor; saved model IDs remain unchanged. */
export function collapseFusionModels<T extends ModelEsque & { instanceId: ProviderInstanceId }>(
  models: ReadonlyArray<T>,
  activeInstanceId: ProviderInstanceId,
  activeModel: string,
): T[] {
  const seen = new Set<ProviderInstanceId>();
  return models.flatMap((model) => {
    if (!model.fusion || model.isUnavailable) return [model];
    if (seen.has(model.instanceId)) return [];
    seen.add(model.instanceId);
    const active =
      model.instanceId === activeInstanceId
        ? models.find(
            (entry) =>
              entry.instanceId === activeInstanceId &&
              entry.slug === activeModel &&
              entry.fusion &&
              !entry.isUnavailable,
          )
        : undefined;
    return [{ ...(active ?? model), name: "Fusion", shortName: "Fusion" }];
  });
}

/** Preserve the sidekick when changing leads, falling back only to an offered pairing. */
export function findFusionLeadPairing(
  models: ReadonlyArray<ModelEsque>,
  leadId: string,
  sidekickId: string,
) {
  const candidates = models.filter(
    (model) => model.fusion?.lead.id === leadId && !model.isUnavailable,
  );
  return candidates.find((model) => model.fusion?.sidekick.id === sidekickId) ?? candidates[0];
}
