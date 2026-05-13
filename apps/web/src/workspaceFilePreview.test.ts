import { describe, expect, it } from "vitest";
import { EnvironmentId } from "@t3tools/contracts";

import { resolveWorkspaceFilePreviewTarget } from "./workspaceFilePreview";

const environmentId = EnvironmentId.make("env-preview-test");

describe("resolveWorkspaceFilePreviewTarget", () => {
  it("resolves absolute workspace paths to relative read targets", () => {
    expect(
      resolveWorkspaceFilePreviewTarget({
        environmentId,
        cwd: "/repo/project",
        targetPath: "/repo/project/src/index.ts:12:4",
      }),
    ).toEqual({
      environmentId,
      cwd: "/repo/project",
      relativePath: "src/index.ts",
      displayPath: "src/index.ts",
      line: 12,
      column: 4,
    });
  });

  it("resolves relative paths and keeps custom display labels", () => {
    expect(
      resolveWorkspaceFilePreviewTarget({
        environmentId,
        cwd: "/repo/project",
        targetPath: "./src/index.ts:3",
        displayPath: "project/src/index.ts:3",
      }),
    ).toEqual({
      environmentId,
      cwd: "/repo/project",
      relativePath: "src/index.ts",
      displayPath: "project/src/index.ts:3",
      line: 3,
    });
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(
      resolveWorkspaceFilePreviewTarget({
        environmentId,
        cwd: "/repo/project",
        targetPath: "/repo/other/src/index.ts",
      }),
    ).toBeNull();
  });
});
