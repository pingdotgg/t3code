import { UsageProviderKind } from "@t3tools/contracts";
import { USAGE_WINDOW_IDS, type UsageWindowId } from "@t3tools/shared/usageFormat";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const UsageMetricSchema = Schema.Literals(["cost", "tokens", "limits"]);
const HiddenProvidersSchema = Schema.optional(Schema.Array(UsageProviderKind));

const UsagePagePreferencesSchema = Schema.Struct({
  metric: UsageMetricSchema,
  window: Schema.Literals(USAGE_WINDOW_IDS),
  hiddenProviders: HiddenProvidersSchema,
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

const LegacyUsagePagePreferencesSchema = Schema.Struct({
  metric: UsageMetricSchema,
  windowDays: Schema.Literals([1, 7, 30, 90]),
  hiddenProviders: HiddenProvidersSchema,
});

const StoredUsagePagePreferencesSchema = Schema.Union([
  UsagePagePreferencesSchema,
  LegacyUsagePagePreferencesSchema,
]);

const LEGACY_WINDOW_BY_DAYS: Record<1 | 7 | 30 | 90, UsageWindowId> = {
  1: "24h",
  7: "7d",
  30: "30d",
  90: "90d",
};

const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "limits", window: "30d" };

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    const stored = getLocalStorageItem(STORAGE_KEY, StoredUsagePagePreferencesSchema);
    if (stored === null) return DEFAULT_PREFERENCES;
    if ("window" in stored) return stored;
    return {
      metric: stored.metric,
      window: LEGACY_WINDOW_BY_DAYS[stored.windowDays],
      ...(stored.hiddenProviders === undefined ? {} : { hiddenProviders: stored.hiddenProviders }),
    };
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return DEFAULT_PREFERENCES;
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}
