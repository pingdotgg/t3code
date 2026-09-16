import { expandQueryAcrossKeyboardLayouts } from "@t3tools/shared/keyboardLayouts";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";

/**
 * Match the terms a user can actually see or recognize in the model picker. The
 * query is also read as the US QWERTY keys that produced it, so a model id or
 * provider name still matches when a non-Latin layout was active: `/model` in
 * the composer menu leaves the user here with that layout still on.
 */
export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  const queryForms = [query, ...expandQueryAcrossKeyboardLayouts(query)];
  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => {
    const lowercased = value.toLocaleLowerCase();
    return queryForms.some((queryForm) => lowercased.includes(queryForm));
  });
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

/** A model can disappear while the picker is open. */
export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some((model) => model.key === pending.key && !model.isUnavailable),
  );
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
