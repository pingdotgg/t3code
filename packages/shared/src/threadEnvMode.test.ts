import { describe, expect, it } from "vite-plus/test";

import { isDefaultThreadEnvModeSettled, resolveDefaultThreadEnvMode } from "./threadEnvMode.ts";

describe("resolveDefaultThreadEnvMode", () => {
  it("prefers the setting over t3.json over local", () => {
    expect(resolveDefaultThreadEnvMode({ setting: "local", projectFile: "worktree" })).toBe(
      "local",
    );
    expect(resolveDefaultThreadEnvMode({ setting: null, projectFile: "worktree" })).toBe(
      "worktree",
    );
    expect(resolveDefaultThreadEnvMode({ setting: undefined, projectFile: null })).toBe("local");
  });
});

describe("isDefaultThreadEnvModeSettled", () => {
  it("settles on an explicit pick or a setting even while the file loads", () => {
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: "local",
        setting: null,
        projectFilePending: true,
      }),
    ).toBe(true);
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        setting: "worktree",
        projectFilePending: true,
      }),
    ).toBe(true);
  });

  it("stays unsettled only while a consulted file read is pending", () => {
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        setting: null,
        projectFilePending: true,
      }),
    ).toBe(false);
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        setting: null,
        projectFilePending: false,
      }),
    ).toBe(true);
  });
});
