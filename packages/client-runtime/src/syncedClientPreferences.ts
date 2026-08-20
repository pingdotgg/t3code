import {
  CommandId,
  type PatchSyncedClientPreferencesRequest,
  type SyncedClientPreferencesPatch,
  type SyncedClientPreferencesUpdatedAt,
} from "@t3tools/contracts";

export const SYNCED_CLIENT_PREFERENCE_MAX_ATTEMPTS = 3;

export function syncedClientPreferenceRetryDelayMs(attempt: number): number {
  return 1_000 * 2 ** (attempt - 1);
}

export function createPlanModePreferencePatchRequest(
  value: boolean,
  updatedAt: SyncedClientPreferencesUpdatedAt,
): PatchSyncedClientPreferencesRequest {
  return createSyncedClientPreferencesPatchRequest({ planModeEnabled: value }, updatedAt);
}

export function createSyncedClientPreferencesPatchRequest(
  patch: SyncedClientPreferencesPatch,
  updatedAt: SyncedClientPreferencesUpdatedAt,
): PatchSyncedClientPreferencesRequest {
  const fields = Object.keys(patch).sort();
  const identity =
    fields.length === 1 && fields[0] === "planModeEnabled" && patch.planModeEnabled !== undefined
      ? patch.planModeEnabled
        ? "1"
        : "0"
      : JSON.stringify(
          fields.map((field) => [field, patch[field as keyof SyncedClientPreferencesPatch]]),
        );
  return {
    commandId: CommandId.make(`client-preferences:${updatedAt}:${identity}`),
    patch,
    updatedAt,
  };
}
