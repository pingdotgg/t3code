import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90]),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

// Limits is what most people open the page for (how much subscription quota is
// left, and when it resets), so it is the first-visit default; the last picked
// tab sticks after that.
const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "limits", windowDays: 30 };

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    return getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema) ?? DEFAULT_PREFERENCES;
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

const EXPLORER_STORAGE_KEY = "t3code:usage-explorer:v1";
const UsageExplorerPreferencesSchema = Schema.Struct({
  dimension: Schema.Literals(["project", "provider", "model", "environment"]),
  running: Schema.Boolean,
  columns: Schema.Array(
    Schema.Literals([
      "cost",
      "share",
      "tokens",
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "cacheWriteCost",
      "cached",
      "change",
    ]),
  ),
  /** Favourite projects, keyed by environment and project id. */
  favorites: Schema.Array(Schema.String),
});
export type UsageExplorerPreferences = typeof UsageExplorerPreferencesSchema.Type;

const DEFAULT_EXPLORER_PREFERENCES: UsageExplorerPreferences = {
  dimension: "project",
  running: false,
  columns: ["cost", "share", "tokens"],
  favorites: [],
};

export function readUsageExplorerPreferences(): UsageExplorerPreferences {
  try {
    return (
      getLocalStorageItem(EXPLORER_STORAGE_KEY, UsageExplorerPreferencesSchema) ??
      DEFAULT_EXPLORER_PREFERENCES
    );
  } catch (error) {
    console.error("Could not read Usage breakdown preferences.", error);
    return DEFAULT_EXPLORER_PREFERENCES;
  }
}

export function saveUsageExplorerPreferences(preferences: UsageExplorerPreferences): void {
  try {
    setLocalStorageItem(EXPLORER_STORAGE_KEY, preferences, UsageExplorerPreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage breakdown preferences.", error);
  }
}
