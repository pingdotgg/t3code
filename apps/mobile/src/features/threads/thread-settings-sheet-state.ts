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
 * Group one provider's catalog by vendor, in first-seen order, keeping each
 * vendor's models in catalog order. The catalog itself stays name-sorted (its
 * order feeds the implicit default model), so grouping happens here; models
 * without a vendor form one flat group placed first, matching the web
 * picker's custom-models-above-sections layout. Returns null when fewer than
 * two vendors are present — a single header is noise.
 */
export function catalogVendorRuns(models: ReadonlyArray<ModelOption>): ReadonlyArray<{
  readonly subProvider: string | undefined;
  readonly models: ReadonlyArray<ModelOption>;
}> | null {
  const runs: Array<{ subProvider: string | undefined; models: ModelOption[] }> = [];
  const runByVendor = new Map<string | undefined, { models: ModelOption[] }>();
  for (const model of models) {
    const existing = runByVendor.get(model.subProvider);
    if (existing) {
      existing.models.push(model);
    } else {
      const run = { subProvider: model.subProvider, models: [model] };
      runByVendor.set(model.subProvider, run);
      runs.push(run);
    }
  }
  const vendors = new Set(runs.flatMap((run) => (run.subProvider ? [run.subProvider] : [])));
  if (vendors.size < 2) {
    return null;
  }
  return [
    ...runs.filter((run) => run.subProvider === undefined),
    ...runs.filter((run) => run.subProvider !== undefined),
  ];
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
