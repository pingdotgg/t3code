import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createSyncedClientPreferencesWrite,
  reconcileSyncedClientPreferences,
} from "./synced-client-preferences-model";

describe("mobile synced theme preferences", () => {
  it("writes light and dark theme ids as independent fields", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const common = {
      connectedEnvironmentIds: [environmentId],
      now: "2026-08-14T12:00:00.000Z",
    } as const;
    const light = createSyncedClientPreferencesWrite({
      ...common,
      patch: { lightThemeId: "catppuccin-latte" },
    });
    const dark = createSyncedClientPreferencesWrite({
      ...common,
      patch: { darkThemeId: "dracula" },
    });

    expect(light.environmentPatches[0]?.input.patch).toEqual({
      lightThemeId: "catppuccin-latte",
    });
    expect(dark.environmentPatches[0]?.input.patch).toEqual({ darkThemeId: "dracula" });
    expect(light.environmentPatches[0]?.input.commandId).not.toBe(
      dark.environmentPatches[0]?.input.commandId,
    );
  });

  it("adopts a newer light selection without collapsing the local dark selection", () => {
    const result = reconcileSyncedClientPreferences({
      local: {
        values: { lightThemeId: "t3-code", darkThemeId: "dracula" },
        updatedAtByField: {
          lightThemeId: "2026-08-14T12:00:00.000Z",
          darkThemeId: "2026-08-14T12:02:00.000Z",
        },
      },
      environments: [
        {
          environmentId: EnvironmentId.make("environment-a"),
          preferences: {
            lightThemeId: "catppuccin-latte",
            darkThemeId: "tokyo-night",
            updatedAtByField: {
              lightThemeId: "2026-08-14T12:01:00.000Z",
              darkThemeId: "2026-08-14T12:01:00.000Z",
            },
            updatedAt: "2026-08-14T12:01:00.000Z",
          },
        },
      ],
      fields: ["lightThemeId", "darkThemeId"],
      now: "2026-08-14T12:03:00.000Z",
    });

    expect(result.localPatch?.values).toEqual({ lightThemeId: "catppuccin-latte" });
    expect(result.environmentPatches).toHaveLength(1);
    expect(result.environmentPatches[0]?.input.patch).toEqual({ darkThemeId: "dracula" });
  });
});
