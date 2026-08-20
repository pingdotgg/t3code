import {
  CommandId,
  type PatchSyncedClientPreferencesRequest,
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
  return {
    commandId: CommandId.make(`client-preferences:${updatedAt}:${value ? "1" : "0"}`),
    patch: { planModeEnabled: value },
    updatedAt,
  };
}
