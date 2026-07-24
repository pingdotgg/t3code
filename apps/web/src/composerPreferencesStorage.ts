import { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";
export const COMPOSER_PREFERENCES_STORAGE_KEY = "t3code:composer-preferences:v1";

export const PersistedComposerPreferencesSchema = Schema.Struct({
  version: Schema.Literal(1),
  stickyModelSelectionByProvider: Schema.Record(ProviderInstanceId, ModelSelection),
  stickyActiveProvider: Schema.NullOr(ProviderInstanceId),
});
export type PersistedComposerPreferences = typeof PersistedComposerPreferencesSchema.Type;

const isPersistedComposerPreferences = Schema.is(PersistedComposerPreferencesSchema);

export function parsePersistedComposerPreferences(
  raw: string,
): PersistedComposerPreferences | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPersistedComposerPreferences(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readLegacyComposerPreferences(
  storage: { readonly getItem: (key: string) => string | null } | undefined,
): PersistedComposerPreferences | null {
  if (storage === undefined) {
    return null;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const state = (parsed as { readonly state?: unknown }).state;
    if (typeof state !== "object" || state === null || Array.isArray(state)) {
      return null;
    }
    const legacyState = state as {
      readonly stickyModelSelectionByProvider?: unknown;
      readonly stickyActiveProvider?: unknown;
    };
    if (
      legacyState.stickyModelSelectionByProvider === undefined &&
      legacyState.stickyActiveProvider === undefined
    ) {
      return null;
    }

    const preferences = {
      version: 1,
      stickyModelSelectionByProvider: legacyState.stickyModelSelectionByProvider ?? {},
      stickyActiveProvider: legacyState.stickyActiveProvider ?? null,
    };
    return isPersistedComposerPreferences(preferences) ? preferences : null;
  } catch {
    return null;
  }
}
