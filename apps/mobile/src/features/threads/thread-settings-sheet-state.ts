import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { providerNeedsSetup } from "../settings/provider-setup-state";

/** Read setup choices from this environment, not the selectable model list. */
export function providerSetupCandidates(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId?: ProviderInstanceId;
  readonly providerFilter: string | null;
  readonly query: string;
}): ReadonlyArray<ServerProvider> {
  const query = input.query.trim().toLocaleLowerCase();
  return input.providers.filter(
    (provider) =>
      providerNeedsSetup(provider) &&
      (input.instanceId === undefined || provider.instanceId === input.instanceId) &&
      (input.providerFilter === null || provider.instanceId === input.providerFilter) &&
      (query.length === 0 ||
        [provider.displayName ?? "", provider.driver, provider.instanceId].some((label) =>
          label.toLocaleLowerCase().includes(query),
        )),
  );
}

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
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
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

/** A model can disappear while its setup page is open inside the picker. */
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
