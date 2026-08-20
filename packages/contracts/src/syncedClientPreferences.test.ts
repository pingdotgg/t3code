import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  PatchSyncedClientPreferencesRequest,
  SyncedClientPreferences,
  SyncedClientPreferencesPatch,
} from "./syncedClientPreferences.ts";

const decodePreferences = Schema.decodeUnknownSync(SyncedClientPreferences);
const decodePatch = Schema.decodeUnknownSync(SyncedClientPreferencesPatch);
const decodeRequest = Schema.decodeUnknownSync(PatchSyncedClientPreferencesRequest);

describe("SyncedClientPreferences", () => {
  it("keeps the contract scoped to the Plan Mode rollout", () => {
    const preferences = decodePreferences({
      planModeEnabled: true,
      updatedAtByField: { planModeEnabled: "2026-08-14T10:00:00.000Z" },
      updatedAt: "2026-08-14T10:00:00.000Z",
      themeId: "ignored",
    });
    const patch = decodePatch({ planModeEnabled: false, themeId: "ignored" });

    expect(Object.keys(preferences).sort()).toEqual([
      "planModeEnabled",
      "updatedAt",
      "updatedAtByField",
    ]);
    expect(patch).toEqual({ planModeEnabled: false });
  });

  it("rejects non-canonical LWW stamps", () => {
    for (const updatedAt of ["not-a-date", "2026-02-30T00:00:00.000Z"]) {
      expect(() =>
        decodePreferences({ planModeEnabled: true, updatedAtByField: {}, updatedAt }),
      ).toThrow();
    }
  });

  it("requires projected preferences to carry per-field clocks", () => {
    expect(() =>
      decodePreferences({
        planModeEnabled: true,
        updatedAt: "2026-08-14T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects empty and unknown-only patches at the RPC boundary", () => {
    expect(() => decodePatch({})).toThrow();
    expect(() =>
      decodeRequest({
        commandId: "client-preferences:test",
        patch: { unsupported: true },
        updatedAt: "2026-08-14T12:00:00.000Z",
      }),
    ).toThrow();
  });
});
