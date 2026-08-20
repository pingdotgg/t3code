import { describe, expect, it } from "vite-plus/test";

import {
  createPlanModePreferencePatchRequest,
  createSyncedClientPreferencesPatchRequest,
  syncedClientPreferenceRetryDelayMs,
} from "./syncedClientPreferences.js";

describe("synced client preferences", () => {
  it("keys idempotency by the field stamp and canonical payload", () => {
    const first = createPlanModePreferencePatchRequest(true, "2026-08-14T12:00:00.000Z");
    const retry = createPlanModePreferencePatchRequest(true, "2026-08-14T12:00:00.000Z");
    const distinctValue = createPlanModePreferencePatchRequest(false, "2026-08-14T12:00:00.000Z");

    expect(first).toEqual({
      commandId: "client-preferences:2026-08-14T12:00:00.000Z:1",
      patch: { planModeEnabled: true },
      updatedAt: "2026-08-14T12:00:00.000Z",
    });
    expect(retry.commandId).toBe(first.commandId);
    expect(distinctValue.commandId).toBe("client-preferences:2026-08-14T12:00:00.000Z:0");
  });

  it("uses the shared exponential retry policy", () => {
    expect([1, 2, 3].map(syncedClientPreferenceRetryDelayMs)).toEqual([1_000, 2_000, 4_000]);
  });

  it("canonicalizes multi-field appearance payloads", () => {
    const updatedAt = "2026-08-14T12:00:00.000Z";
    const first = createSyncedClientPreferencesPatchRequest(
      { appearanceMode: "system", lightThemeId: "catppuccin-latte" },
      updatedAt,
    );
    const reordered = createSyncedClientPreferencesPatchRequest(
      { lightThemeId: "catppuccin-latte", appearanceMode: "system" },
      updatedAt,
    );
    const distinct = createSyncedClientPreferencesPatchRequest(
      { appearanceMode: "dark", lightThemeId: "catppuccin-latte" },
      updatedAt,
    );

    expect(reordered.commandId).toBe(first.commandId);
    expect(distinct.commandId).not.toBe(first.commandId);
  });
});
