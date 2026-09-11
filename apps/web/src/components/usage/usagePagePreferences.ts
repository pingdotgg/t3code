import * as Schema from "effect/Schema";
import type { EnvironmentId } from "@t3tools/contracts";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const DEFAULTS = {
  metric: "cost",
  windowDays: 30,
  selectedEnvironmentIds: null,
} as const;
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90]),
  // Null follows all environments, including ones connected later. An array is
  // an explicit subset; an empty array means nothing is selected. Optional so
  // preferences saved before this field existed still decode.
  selectedEnvironmentIds: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

/** Stored ids back to the selection the usage query expects. */
export function toSelectedEnvironmentIds(
  stored: readonly string[] | null | undefined,
): ReadonlySet<EnvironmentId> | null {
  if (stored === null || stored === undefined) return null;
  const ids = new Set<string>();
  for (const id of stored) {
    const trimmed = id.trim();
    if (trimmed !== "") ids.add(trimmed);
  }
  return new Set(ids as Set<EnvironmentId>);
}

/** Selection back to a storable shape, deduplicated. */
export function fromSelectedEnvironmentIds(
  selected: ReadonlySet<EnvironmentId> | null,
): readonly string[] | null {
  if (selected === null) return null;
  return [...new Set([...selected].map((id) => String(id).trim()).filter((id) => id !== ""))];
}

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    return (
      getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema) ?? {
        metric: DEFAULTS.metric,
        windowDays: DEFAULTS.windowDays,
        selectedEnvironmentIds: DEFAULTS.selectedEnvironmentIds,
      }
    );
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return {
      metric: DEFAULTS.metric,
      windowDays: DEFAULTS.windowDays,
      selectedEnvironmentIds: DEFAULTS.selectedEnvironmentIds,
    };
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}
