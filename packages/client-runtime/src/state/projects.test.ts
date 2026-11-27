import { describe, expect, it } from "vite-plus/test";

import { isScratchProject, resolveProjectFolderChange } from "./projects.ts";

describe("isScratchProject", () => {
  it.each([null, undefined])(
    "recognises a loaded scratch project when its environment offers no available root (%s)",
    (scratchWorkspaceRoot) => {
      const project = { workspaceRoot: "/remote/scratch", isScratch: true as const };

      expect(isScratchProject(project, scratchWorkspaceRoot)).toBe(true);
    },
  );
});

describe("resolveProjectFolderChange", () => {
  it.each([
    ["a bare name", "renamed", "/work/old", "/work/old/renamed"],
    ["a bare nested name", "team/api", "/work/old", "/work/old/team/api"],
    ["a parent-relative path", "../renamed", "/work/old", "/work/renamed"],
    ["an absolute path", "/srv/renamed", "/work/old", "/srv/renamed"],
    ["a home path", "~/renamed", "/work/old", "~/renamed"],
    ["a bare name on Windows", "renamed", "C:\\work\\old", "C:\\work\\old\\renamed"],
  ])("resolves %s against the old folder", (_label, value, workspaceRoot, expected) => {
    expect(resolveProjectFolderChange(value, workspaceRoot)).toBe(expected);
  });
});
