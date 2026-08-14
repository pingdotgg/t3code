import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

export const SyncedClientAppearanceMode = Schema.Literals(["system", "light", "dark"]);
export type SyncedClientAppearanceMode = typeof SyncedClientAppearanceMode.Type;

const SyncedClientPreferencesUpdatedAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const SyncedClientPreferencesUpdatedAt = IsoDateTime.check(
  Schema.makeFilter(
    (value) =>
      (SyncedClientPreferencesUpdatedAtPattern.test(value) && Number.isFinite(Date.parse(value))) ||
      "Synced client preferences updatedAt must be a canonical UTC timestamp.",
  ),
);
export type SyncedClientPreferencesUpdatedAt = typeof SyncedClientPreferencesUpdatedAt.Type;

const SyncedClientPreferenceFields = {
  planModeEnabled: Schema.optionalKey(Schema.Boolean),
  appearanceMode: Schema.optionalKey(SyncedClientAppearanceMode),
  themeId: Schema.optionalKey(Schema.String),
} as const;

/** Client preferences replicated through one environment's event log. */
export const SyncedClientPreferences = Schema.Struct({
  ...SyncedClientPreferenceFields,
  updatedAt: SyncedClientPreferencesUpdatedAt,
});
export type SyncedClientPreferences = typeof SyncedClientPreferences.Type;

/** Exactly the preference keys that clients may patch in this rollout. */
export const SyncedClientPreferencesPatch = Schema.Struct(SyncedClientPreferenceFields).check(
  Schema.makeFilter(
    (patch) =>
      patch.planModeEnabled !== undefined ||
      patch.appearanceMode !== undefined ||
      patch.themeId !== undefined ||
      "Synced client preferences patch must include at least one supported preference.",
  ),
);
export type SyncedClientPreferencesPatch = typeof SyncedClientPreferencesPatch.Type;

export const GetSyncedClientPreferencesRequest = Schema.Struct({});
export type GetSyncedClientPreferencesRequest = typeof GetSyncedClientPreferencesRequest.Type;

export const PatchSyncedClientPreferencesRequest = Schema.Struct({
  patch: SyncedClientPreferencesPatch,
  updatedAt: SyncedClientPreferencesUpdatedAt,
});
export type PatchSyncedClientPreferencesRequest = typeof PatchSyncedClientPreferencesRequest.Type;
