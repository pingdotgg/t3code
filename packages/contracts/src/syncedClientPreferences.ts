import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime } from "./baseSchemas.ts";

const SyncedClientPreferencesUpdatedAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const SyncedClientPreferencesUpdatedAt = IsoDateTime.check(
  Schema.makeFilter(
    (value) =>
      (SyncedClientPreferencesUpdatedAtPattern.test(value) &&
        Option.exists(DateTime.make(value), (parsed) => DateTime.formatIso(parsed) === value)) ||
      "Synced client preferences updatedAt must be a canonical UTC timestamp.",
  ),
);
export type SyncedClientPreferencesUpdatedAt = typeof SyncedClientPreferencesUpdatedAt.Type;

export function nextSyncedClientPreferencesUpdatedAt(
  updatedAts: ReadonlyArray<string | undefined>,
  now: string,
): string {
  let latest: string | undefined;
  for (const updatedAt of updatedAts) {
    if (updatedAt !== undefined && (latest === undefined || updatedAt > latest)) latest = updatedAt;
  }
  if (latest === undefined || now > latest) return now;
  return DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(latest), { milliseconds: 1 }));
}

const SyncedClientPreferenceFields = {
  planModeEnabled: Schema.optionalKey(Schema.Boolean),
} as const;

export const SYNCED_CLIENT_PREFERENCE_FIELDS = ["planModeEnabled"] as const;
export type SyncedClientPreferenceField = (typeof SYNCED_CLIENT_PREFERENCE_FIELDS)[number];

export const SyncedClientPreferencesUpdatedAtByField = Schema.Struct({
  planModeEnabled: Schema.optionalKey(SyncedClientPreferencesUpdatedAt),
});
export type SyncedClientPreferencesUpdatedAtByField =
  typeof SyncedClientPreferencesUpdatedAtByField.Type;

export const SyncedClientPreferences = Schema.Struct({
  ...SyncedClientPreferenceFields,
  updatedAtByField: SyncedClientPreferencesUpdatedAtByField,
  updatedAt: SyncedClientPreferencesUpdatedAt,
});
export type SyncedClientPreferences = typeof SyncedClientPreferences.Type;

export function getSyncedClientPreferenceUpdatedAt(
  preferences: SyncedClientPreferences | undefined,
  field: SyncedClientPreferenceField,
): SyncedClientPreferencesUpdatedAt | undefined {
  if (preferences?.[field] === undefined) return undefined;
  return preferences.updatedAtByField[field];
}

export const SyncedClientPreferencesPatch = Schema.Struct(SyncedClientPreferenceFields).check(
  Schema.makeFilter(
    (patch) =>
      patch.planModeEnabled !== undefined ||
      "Synced client preferences patch must include at least one supported preference.",
  ),
);
export type SyncedClientPreferencesPatch = typeof SyncedClientPreferencesPatch.Type;

export const PatchSyncedClientPreferencesRequest = Schema.Struct({
  commandId: CommandId,
  patch: SyncedClientPreferencesPatch,
  updatedAt: SyncedClientPreferencesUpdatedAt,
});
export type PatchSyncedClientPreferencesRequest = typeof PatchSyncedClientPreferencesRequest.Type;
