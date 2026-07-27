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

  it("preserves per-project overrides", () => {
    expect(
      resolveMobileProjectGroupingSettings({
        projectGroupingOverrides: { "environment:/work/t3code": "separate" },
      }).sidebarProjectGroupingOverrides,
    ).toEqual({ "environment:/work/t3code": "separate" });
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
