import { describe, expect, it } from "vite-plus/test";

import { resolveAddProjectPath } from "./useAddProjectAtPath";

describe("resolveAddProjectPath", () => {
  it.each([
    {
      input: { rawCwd: "C:\\code\\app", platform: "Linux", currentProjectCwd: null },
      expected: {
        kind: "invalid",
        message: "Windows-style paths are only supported on Windows.",
      },
    },
    {
      input: { rawCwd: "./app", platform: "Linux", currentProjectCwd: null },
      expected: { kind: "invalid", message: "Relative paths require an active project." },
    },
    {
      input: { rawCwd: "../app", platform: "Linux", currentProjectCwd: "/home/me/web" },
      expected: { kind: "path", cwd: "/home/me/app" },
    },
    {
      input: { rawCwd: "  /home/me/app/ ", platform: "Linux", currentProjectCwd: null },
      expected: { kind: "path", cwd: "/home/me/app" },
    },
    {
      input: { rawCwd: "   ", platform: "Linux", currentProjectCwd: null },
      expected: { kind: "empty" },
    },
  ])("resolves $input.rawCwd", ({ input, expected }) => {
    expect(resolveAddProjectPath(input)).toEqual(expected);
  });
});
