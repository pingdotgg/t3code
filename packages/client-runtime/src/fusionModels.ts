import type { ServerProviderModel } from "@t3tools/contracts";

type FusionModel = Pick<ServerProviderModel, "fusion"> & {
  readonly isUnavailable?: boolean | undefined;
};

/** One available Fusion entry per account, retaining the selected pair and unavailable rows. */
export function collapseFusionModels<T extends FusionModel>(
  models: ReadonlyArray<T>,
  instanceId: (model: T) => string,
  isSelected: (model: T) => boolean,
): T[] {
  const selected = new Map(
    models
      .filter((model) => model.fusion && !model.isUnavailable && isSelected(model))
      .map((model) => [instanceId(model), model]),
  );
  const seen = new Set<string>();
  return models.flatMap((model) => {
    if (!model.fusion || model.isUnavailable) return [model];
    const id = instanceId(model);
    if (seen.has(id)) return [];
    seen.add(id);
    return [selected.get(id) ?? model];
  });
}

/** Models belong to one account. Each lead selects an offered pair, keeping the current sidekick. */
export function getFusionChoices<T extends FusionModel>(models: ReadonlyArray<T>, current: T) {
  const leads = new Map<string, T>();
  const sidekicks: T[] = [];
  for (const model of models) {
    if (!model.fusion || model.isUnavailable) continue;
    const { lead, sidekick } = model.fusion;
    if (!leads.has(lead.id) || sidekick.id === current.fusion?.sidekick.id) {
      leads.set(lead.id, model);
    }
    if (lead.id === current.fusion?.lead.id) sidekicks.push(model);
  }
  return { lead: [...leads.values()], sidekick: sidekicks };
}
