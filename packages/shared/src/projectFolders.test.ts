import { describe, expect, it } from "vite-plus/test";

import {
  additionalProjectFolderPaths,
  planProjectFolderMutation,
  projectSourceFolderPaths,
  projectSourceFolders,
  sameFolderSet,
} from "./projectFolders.ts";

const project = {
  workspaceRoot: "/repo/app",
  additionalFolders: [{ path: "/repo/design-system" }, { path: "/repo/docs", label: "Docs" }],
};

describe("projectSourceFolders", () => {
  it("lists the primary folder first", () => {
    expect(projectSourceFolders(project)).toEqual([
      { path: "/repo/app", isPrimary: true },
      { path: "/repo/design-system", isPrimary: false },
      { path: "/repo/docs", label: "Docs", isPrimary: false },
    ]);
  });

  it("separates all paths from non-primary paths", () => {
    expect(projectSourceFolderPaths(project)).toEqual([
      "/repo/app",
      "/repo/design-system",
      "/repo/docs",
    ]);
    expect(additionalProjectFolderPaths(project)).toEqual(["/repo/design-system", "/repo/docs"]);
  });
});

describe("sameFolderSet", () => {
  it("ignores ordering", () => {
    expect(sameFolderSet(["/a", "/b"], ["/b", "/a"])).toBe(true);
  });

  it("normalizes trailing separators", () => {
    expect(sameFolderSet(["/a/"], ["/a"])).toBe(true);
  });

  it("treats Windows paths case-insensitively", () => {
    expect(sameFolderSet(["C:/Repo"], ["c:\\repo"])).toBe(true);
  });

  it("detects additions and removals", () => {
    expect(sameFolderSet(["/a"], ["/a", "/b"])).toBe(false);
    expect(sameFolderSet(["/a", "/b"], ["/a"])).toBe(false);
    expect(sameFolderSet(["/a", "/b"], ["/a", "/c"])).toBe(false);
  });
});

describe("planProjectFolderMutation", () => {
  it("appends a new folder", () => {
    expect(planProjectFolderMutation(project, { kind: "add", path: "/repo/api" })).toEqual({
      additionalFolders: [
        { path: "/repo/design-system" },
        { path: "/repo/docs", label: "Docs" },
        { path: "/repo/api" },
      ],
    });
  });

  it("refuses to add a folder the project already owns", () => {
    expect(planProjectFolderMutation(project, { kind: "add", path: "/repo/app" })).toBeNull();
    expect(planProjectFolderMutation(project, { kind: "add", path: "/repo/docs/" })).toBeNull();
  });

  it("removes a folder", () => {
    expect(
      planProjectFolderMutation(project, { kind: "remove", path: "/repo/design-system" }),
    ).toEqual({ additionalFolders: [{ path: "/repo/docs", label: "Docs" }] });
  });

  it("refuses to remove the primary or an unknown folder", () => {
    expect(planProjectFolderMutation(project, { kind: "remove", path: "/repo/app" })).toBeNull();
    expect(planProjectFolderMutation(project, { kind: "remove", path: "/elsewhere" })).toBeNull();
  });

  it("promotes by swapping the primary into the promoted folder's slot", () => {
    expect(planProjectFolderMutation(project, { kind: "promote", path: "/repo/docs" })).toEqual({
      workspaceRoot: "/repo/docs",
      additionalFolders: [{ path: "/repo/design-system" }, { path: "/repo/app" }],
    });
  });

  it("keeps the folder set unchanged across a promotion", () => {
    const promoted = planProjectFolderMutation(project, { kind: "promote", path: "/repo/docs" });
    expect(promoted).not.toBeNull();
    const next = {
      workspaceRoot: promoted!.workspaceRoot!,
      additionalFolders: promoted!.additionalFolders,
    };
    expect(sameFolderSet(projectSourceFolderPaths(project), projectSourceFolderPaths(next))).toBe(
      true,
    );
  });

  it("refuses to promote the folder that is already primary", () => {
    expect(planProjectFolderMutation(project, { kind: "promote", path: "/repo/app" })).toBeNull();
    expect(planProjectFolderMutation(project, { kind: "promote", path: "/elsewhere" })).toBeNull();
  });
});
