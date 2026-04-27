import { describe, expect, it } from "vitest";
import { resolveWorkspaceEditorTarget } from "./workspaceEditorTarget";

describe("resolveWorkspaceEditorTarget", () => {
  it("resolves a POSIX absolute path within the workspace", () => {
    expect(resolveWorkspaceEditorTarget("/repo/project/src/app.ts:12:4", "/repo/project")).toEqual({
      relativePath: "src/app.ts",
      line: 12,
      column: 4,
    });
  });

  it("resolves a Windows absolute path within the workspace", () => {
    expect(
      resolveWorkspaceEditorTarget(
        "C:/Users/mike/dev/forma/apps/web/src/app.ts:9",
        "C:/Users/mike/dev/forma",
      ),
    ).toEqual({
      relativePath: "apps/web/src/app.ts",
      line: 9,
    });
  });

  it("resolves a relative path against the workspace root", () => {
    expect(resolveWorkspaceEditorTarget("./src/app.ts:7", "/repo/project")).toEqual({
      relativePath: "src/app.ts",
      line: 7,
    });
  });

  it("rejects paths outside of the workspace root", () => {
    expect(resolveWorkspaceEditorTarget("/repo/other/src/app.ts", "/repo/project")).toBeNull();
    expect(resolveWorkspaceEditorTarget("../escape.ts", "/repo/project")).toBeNull();
  });

  it("rejects the workspace root itself", () => {
    expect(resolveWorkspaceEditorTarget("/repo/project", "/repo/project")).toBeNull();
  });
});
