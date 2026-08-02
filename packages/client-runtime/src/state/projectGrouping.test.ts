import { describe, expect, it } from "vite-plus/test";

import { buildProjectPickerDescription } from "./projectGrouping.ts";

describe("buildProjectPickerDescription", () => {
  it("adds the selected environment when several environments are visible", () => {
    expect(
      buildProjectPickerDescription({
        workspaceRoot: "/Users/henry/Desktop",
        environmentLabel: "Henry's Mac Studio",
        showEnvironmentLabel: true,
      }),
    ).toBe("/Users/henry/Desktop · Henry's Mac Studio");
  });

  it("keeps the workspace path compact for a single environment", () => {
    expect(
      buildProjectPickerDescription({
        workspaceRoot: "/Users/henry/Desktop",
        environmentLabel: "Henry's MacBook",
        showEnvironmentLabel: false,
      }),
    ).toBe("/Users/henry/Desktop");
  });
});
