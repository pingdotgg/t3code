import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
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
const isProviderDriverKind = Schema.is(ProviderDriverKind);
const PROVIDER_INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const LEGACY_PROVIDER_KINDS = ["codex", "claudeAgent", "cursor", "opencode"] as const;
type LegacyProviderKind = (typeof LEGACY_PROVIDER_KINDS)[number];

function normalizeProviderInstanceId(value: unknown): ProviderInstanceId | null {
  return typeof value === "string" && PROVIDER_INSTANCE_ID_PATTERN.test(value)
    ? ProviderInstanceId.make(value)
    : null;
}

function normalizeProviderDriverKind(value: unknown): ProviderDriverKind | null {
  return isProviderDriverKind(value) ? value : null;
}

function coerceProviderOptionSelections(
  value: unknown,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (Array.isArray(value)) {
    const selections = value.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return [];
      }
      const { id, value: optionValue } = entry as Record<string, unknown>;
      return typeof id === "string" &&
        id.length > 0 &&
        (typeof optionValue === "string" || typeof optionValue === "boolean")
        ? [{ id, value: optionValue }]
        : [];
    });
    return selections.length > 0 ? selections : undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const selections = Object.entries(value).flatMap(([id, optionValue]) =>
    typeof optionValue === "string" || typeof optionValue === "boolean"
      ? [{ id, value: optionValue }]
      : [],
  );
  return selections.length > 0 ? selections : undefined;
}

function migratePreV3ComposerPreferences(
  legacyState: Record<string, unknown>,
): PersistedComposerPreferences | null {
  if (
    legacyState.stickyModelSelection === undefined &&
    legacyState.stickyModelOptions === undefined &&
    legacyState.stickyProvider === undefined &&
    legacyState.stickyModel === undefined
  ) {
    return null;
  }

  const legacyOptions =
    typeof legacyState.stickyModelOptions === "object" &&
    legacyState.stickyModelOptions !== null &&
    !Array.isArray(legacyState.stickyModelOptions)
      ? (legacyState.stickyModelOptions as Record<string, unknown>)
      : {};
  const optionsByProvider = Object.fromEntries(
    LEGACY_PROVIDER_KINDS.flatMap((provider) => {
      const options = coerceProviderOptionSelections(legacyOptions[provider]);
      return options ? [[provider, options]] : [];
    }),
  ) as Partial<Record<LegacyProviderKind, ReadonlyArray<ProviderOptionSelection>>>;

  const selectionCandidate =
    typeof legacyState.stickyModelSelection === "object" &&
    legacyState.stickyModelSelection !== null &&
    !Array.isArray(legacyState.stickyModelSelection)
      ? (legacyState.stickyModelSelection as Record<string, unknown>)
      : {};
  const selectionInstanceId =
    normalizeProviderInstanceId(selectionCandidate.instanceId) ??
    normalizeProviderInstanceId(selectionCandidate.provider) ??
    normalizeProviderInstanceId(legacyState.stickyProvider) ??
    ProviderInstanceId.make("codex");
  const driverHint =
    normalizeProviderDriverKind(selectionCandidate.provider) ??
    normalizeProviderDriverKind(legacyState.stickyProvider) ??
    normalizeProviderDriverKind(selectionInstanceId) ??
    ProviderDriverKind.make("codex");
  const rawModel = selectionCandidate.model ?? legacyState.stickyModel;
  const model = typeof rawModel === "string" ? normalizeModelSlug(rawModel, driverHint) : undefined;
  const selectionProviderKind =
    LEGACY_PROVIDER_KINDS.find((provider) => provider === selectionInstanceId) ?? null;
  const selectionOptions =
    coerceProviderOptionSelections(selectionCandidate.options) ??
    (selectionProviderKind === null ? undefined : optionsByProvider[selectionProviderKind]);
  const selectedModel =
    selectionInstanceId !== null && model
      ? createModelSelection(selectionInstanceId, model, selectionOptions)
      : null;

  const stickyModelSelectionByProvider = Object.fromEntries(
    LEGACY_PROVIDER_KINDS.flatMap((provider) => {
      const options = optionsByProvider[provider];
      if (!options) {
        return [];
      }
      const driver = ProviderDriverKind.make(provider);
      const instanceId = defaultInstanceIdForDriver(driver);
      return [
        [
          instanceId,
          selectedModel?.instanceId === instanceId
            ? selectedModel
            : createModelSelection(
                instanceId,
                DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL,
                options,
              ),
        ],
      ];
    }),
  ) as Record<ProviderInstanceId, ModelSelection>;
  if (selectedModel !== null) {
    stickyModelSelectionByProvider[selectedModel.instanceId] = selectedModel;
  }

  const preferences = {
    version: 1,
    stickyModelSelectionByProvider,
    stickyActiveProvider: normalizeProviderInstanceId(legacyState.stickyProvider),
  };
  return isPersistedComposerPreferences(preferences) ? preferences : null;
}

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
    const legacyState = state as Record<string, unknown>;
    if (
      legacyState.stickyModelSelectionByProvider !== undefined ||
      legacyState.stickyActiveProvider !== undefined
    ) {
      const preferences = {
        version: 1,
        stickyModelSelectionByProvider: legacyState.stickyModelSelectionByProvider ?? {},
        stickyActiveProvider: legacyState.stickyActiveProvider ?? null,
      };
      if (isPersistedComposerPreferences(preferences)) {
        return preferences;
      }
      return null;
    }
    return migratePreV3ComposerPreferences(legacyState);
  } catch {
    return null;
  }
}
