import { describe, expect, it } from "vite-plus/test";

import {
  mobileProjectGroupingModePatch,
  resolveMobileProjectGroupingSettings,
} from "./project-grouping.logic";

describe("mobile project grouping preferences", () => {
  it("maps the legacy boolean while preferring the new mode", () => {
    expect(resolveMobileProjectGroupingSettings({}).sidebarProjectGroupingMode).toBe("repository");
    expect(
      resolveMobileProjectGroupingSettings({ projectGroupingEnabled: false })
        .sidebarProjectGroupingMode,
    ).toBe("separate");
    expect(
      resolveMobileProjectGroupingSettings({
        projectGroupingEnabled: false,
        projectGroupingMode: "repository_path",
      }).sidebarProjectGroupingMode,
    ).toBe("repository_path");
  });

  it("defaults path names off and reads the device preference", () => {
    expect(resolveMobileProjectGroupingSettings({}).sidebarProjectNamesUsePath).toBe(false);
    expect(
      resolveMobileProjectGroupingSettings({ projectNamesUsePath: true })
        .sidebarProjectNamesUsePath,
    ).toBe(true);
  });

  it("dual-writes the legacy boolean for rollback compatibility", () => {
    expect(mobileProjectGroupingModePatch("separate")).toEqual({
      projectGroupingMode: "separate",
      projectGroupingEnabled: false,
    });
    expect(mobileProjectGroupingModePatch("repository_path")).toEqual({
      projectGroupingMode: "repository_path",
      projectGroupingEnabled: true,
    });
  });
});
