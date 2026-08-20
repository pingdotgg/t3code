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
  it("decodes independently clocked Plan Mode and appearance preferences", () => {
    const preferences = decodePreferences({
      planModeEnabled: true,
      appearanceMode: "system",
      lightThemeId: "catppuccin-latte",
      darkThemeId: "dracula",
      updatedAtByField: {
        planModeEnabled: "2026-08-14T10:00:00.000Z",
        appearanceMode: "2026-08-14T10:00:00.000Z",
        lightThemeId: "2026-08-14T10:00:00.000Z",
        darkThemeId: "2026-08-14T10:00:00.000Z",
      },
      updatedAt: "2026-08-14T10:00:00.000Z",
      themeId: "ignored",
    });
    const patch = decodePatch({
      planModeEnabled: false,
      appearanceMode: "dark",
      lightThemeId: "t3-code",
      themeId: "ignored",
    });

    expect(Object.keys(preferences).sort()).toEqual([
      "appearanceMode",
      "darkThemeId",
      "lightThemeId",
      "planModeEnabled",
      "updatedAt",
      "updatedAtByField",
    ]);
    expect(patch).toEqual({
      planModeEnabled: false,
      appearanceMode: "dark",
      lightThemeId: "t3-code",
    });
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
