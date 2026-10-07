import type {
  ModelBenchmarkVariant,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";

import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";

/** Select descriptors that carry reasoning effort, as the traits label reads them. */
const EFFORT_OPTION_IDS = new Set([
  "reasoningEffort",
  "effort",
  "reasoning",
  "variant",
  "thinking",
]);

export interface ParetoPoint {
  readonly entry: ProviderInstanceEntry;
  readonly model: ServerProviderModel;
  readonly effortLabel: string;
  /** The effort option to apply with the model; empty for the model default. */
  readonly options: ReadonlyArray<ProviderOptionSelection>;
  readonly intelligence: number;
  readonly costPerTask: number;
}

/** `openrouter/openai/gpt-6.1-sol` -> `gpt-6-1-sol`, the benchmark family id. */
export function benchmarkFamily(slug: string): string {
  return slug
    .slice(slug.lastIndexOf("/") + 1)
    .toLowerCase()
    .replaceAll(".", "-");
}

/**
 * Every benchmarked model and effort the user can select on a ready instance.
 * A variant is kept only when its effort maps onto one of the model's effort
 * choices; `default` maps to the default choice unless it is also listed by name.
 */
export function matchBenchmarkVariants(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  variants: ReadonlyArray<ModelBenchmarkVariant>,
): ParetoPoint[] {
  const variantsByFamily = new Map<string, ModelBenchmarkVariant[]>();
  for (const variant of variants) {
    variantsByFamily.set(variant.model, [...(variantsByFamily.get(variant.model) ?? []), variant]);
  }
  const points: ParetoPoint[] = [];
  for (const entry of entries) {
    if (!isProviderInstancePickerReady(entry)) continue;
    for (const model of entry.models) {
      if (model.isLegacy) continue;
      const families = [model.slug, ...(model.aliases ?? [])].map(benchmarkFamily);
      const familyVariants = families
        .map((family) => variantsByFamily.get(family))
        .find((found) => found !== undefined);
      if (!familyVariants) {
        // Some providers put the effort in the model id (`gemini-3.8-flash-high`),
        // so the model itself is one variant and needs no option.
        const variant = families
          .map((family) => {
            const split = family.lastIndexOf("-");
            const effort = family.slice(split + 1);
            return split > 0
              ? variantsByFamily.get(family.slice(0, split))?.find((v) => v.effort === effort)
              : undefined;
          })
          .find((found) => found !== undefined);
        if (variant) {
          const { intelligence, costPerTask } = variant;
          points.push({ entry, model, effortLabel: "", options: [], intelligence, costPerTask });
        }
        continue;
      }
      const descriptor = model.capabilities?.optionDescriptors?.find(
        (candidate) => candidate.type === "select" && EFFORT_OPTION_IDS.has(candidate.id),
      );
      const choices = descriptor?.type === "select" ? descriptor.options : undefined;
      for (const variant of familyVariants) {
        const base = {
          entry,
          model,
          intelligence: variant.intelligence,
          costPerTask: variant.costPerTask,
        };
        if (variant.effort === "default" && !descriptor) {
          points.push({ ...base, effortLabel: "Default", options: [] });
          continue;
        }
        const choice =
          variant.effort === "default"
            ? choices?.find((option) => option.isDefault)
            : choices?.find((option) => option.id === variant.effort);
        if (!descriptor || !choice) continue;
        if (
          variant.effort === "default" &&
          familyVariants.some((named) => named.effort === choice.id)
        ) {
          continue;
        }
        points.push({
          ...base,
          effortLabel: choice.label,
          options: [{ id: descriptor.id, value: choice.id }],
        });
      }
    }
  }
  return points;
}

/**
 * Cheapest first, keeping each point smarter than every cheaper one. Matches
 * Slopalytics: ties on cost go to the smarter point, then to input order.
 */
export function paretoFrontier<T extends { costPerTask: number; intelligence: number }>(
  points: ReadonlyArray<T>,
): T[] {
  const frontier: T[] = [];
  let best = Number.NEGATIVE_INFINITY;
  for (const point of points.toSorted(
    (a, b) => a.costPerTask - b.costPerTask || b.intelligence - a.intelligence,
  )) {
    if (point.intelligence > best) {
      frontier.push(point);
      best = point.intelligence;
    }
  }
  return frontier;
}

export function formatCostPerTask(cost: number): string {
  return `$${cost < 1 ? cost.toPrecision(2) : cost.toFixed(2)}`;
}
