import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { buildLegacyClientSettingsMigrationPatch } from "./useSettings";

describe("buildLegacyClientSettingsMigrationPatch", () => {
  it("migrates archive confirmation from legacy local settings", () => {
    expect(
      buildLegacyClientSettingsMigrationPatch({
        confirmThreadArchive: true,
        confirmThreadDelete: false,
      }),
    ).toEqual({
      confirmThreadArchive: true,
      confirmThreadDelete: false,
    });
  });

  it("keeps the client zoom setting defaulted to zero", () => {
    expect(DEFAULT_CLIENT_SETTINGS.windowZoomLevel).toBe(0);
  });
});
