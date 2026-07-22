import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { buildGeneralSettingsRestorePatch } from "./settingsRestore";

describe("buildGeneralSettingsRestorePatch", () => {
  it("restores the changed-files expansion default", () => {
    expect(buildGeneralSettingsRestorePatch().defaultOpenChangedFiles).toBe(
      DEFAULT_UNIFIED_SETTINGS.defaultOpenChangedFiles,
    );
  });
});
