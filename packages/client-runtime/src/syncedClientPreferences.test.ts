import { describe, expect, it } from "vite-plus/test";

import {
  createPlanModePreferencePatchRequest,
  syncedClientPreferenceRetryDelayMs,
} from "./syncedClientPreferences.js";

describe("synced client preferences", () => {
  it("reuses the field stamp as the idempotent command identity", () => {
    expect(createPlanModePreferencePatchRequest(true, "2026-08-14T12:00:00.000Z")).toEqual({
      commandId: "client-preferences:2026-08-14T12:00:00.000Z",
      patch: { planModeEnabled: true },
      updatedAt: "2026-08-14T12:00:00.000Z",
    });
  });

  it("uses the shared exponential retry policy", () => {
    expect([1, 2, 3].map(syncedClientPreferenceRetryDelayMs)).toEqual([1_000, 2_000, 4_000]);
  });
});
