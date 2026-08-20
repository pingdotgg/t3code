import { describe, expect, it } from "vite-plus/test";

import {
  createPlanModePreferencePatchRequest,
  syncedClientPreferenceRetryDelayMs,
} from "./syncedClientPreferences.js";

describe("synced client preferences", () => {
  it("reuses an identical write identity without colliding with another value", () => {
    const updatedAt = "2026-08-14T12:00:00.000Z";
    const enabled = createPlanModePreferencePatchRequest(true, updatedAt);
    expect(enabled).toEqual({
      commandId:
        'client-preferences:planModeEnabled:2026-08-14T12:00:00.000Z:{"planModeEnabled":true}',
      patch: { planModeEnabled: true },
      updatedAt,
    });
    expect(createPlanModePreferencePatchRequest(true, updatedAt)).toEqual(enabled);
    expect(createPlanModePreferencePatchRequest(false, updatedAt).commandId).not.toBe(
      enabled.commandId,
    );
  });

  it("uses the shared exponential retry policy", () => {
    expect([1, 2, 3].map(syncedClientPreferenceRetryDelayMs)).toEqual([1_000, 2_000, 4_000]);
  });
});
