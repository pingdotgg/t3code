import type { ModelOption } from "../../lib/modelOptions";

/** Match the terms a user can actually see or recognize in the model picker. */
export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.subProvider ?? "",
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

/**
 * Chunk one provider's catalog into consecutive vendor runs. The server sorts
 * aggregator catalogs by (subProvider, name), so each vendor arrives as one
 * run; models without a vendor form their own runs and render flat. Returns
 * null when fewer than two vendors are present — a single header is noise.
 */
export function catalogVendorRuns(models: ReadonlyArray<ModelOption>): ReadonlyArray<{
  readonly subProvider: string | undefined;
  readonly models: ReadonlyArray<ModelOption>;
}> | null {
  const runs: Array<{ subProvider: string | undefined; models: ModelOption[] }> = [];
  for (const model of models) {
    const current = runs[runs.length - 1];
    if (current && current.subProvider === model.subProvider) {
      current.models.push(model);
    } else {
      runs.push({ subProvider: model.subProvider, models: [model] });
    }
  }
  const vendors = new Set(runs.flatMap((run) => (run.subProvider ? [run.subProvider] : [])));
  return vendors.size < 2 ? null : runs;
}

/** Preserve staged provider options when the highlighted model is tapped again. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  return input.current?.key === input.pressed.key ? input.current : input.pressed;
}

/**
 * Primary and selected providers start open; all other catalogs start closed.
 * A user's disclosure tap inverts that default until the picker is dismissed.
 */
export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}
