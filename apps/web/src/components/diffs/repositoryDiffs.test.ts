import type { FileDiffMetadata } from "@pierre/diffs";
import type { WorkspaceListRepositoriesResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { diffPanelRepositoryOptions, placeRepositoryFiles } from "./repositoryDiffs";

function fileDiff(name: string, overrides: Partial<FileDiffMetadata> = {}): FileDiffMetadata {
  return {
    name,
    type: "change",
    hunks: [],
    additionLines: [],
    deletionLines: [],
    additionCharacterCount: 0,
    deletionCharacterCount: 0,
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    ...overrides,
  };
}

const workspace: WorkspaceListRepositoriesResult = {
  repositories: [
    {
      name: "home",
      cwd: "/code/home",
      originalPath: "/code/home",
      relativePath: "",
      kind: "home",
      missing: false,
    },
    {
      name: "api",
      cwd: "/tasks/t1/api",
      originalPath: "/code/api",
      relativePath: "../api",
      kind: "repository",
      missing: false,
    },
  ],
  references: [],
  taskFolder: null,
};

describe("placeRepositoryFiles", () => {
  it("puts a repo's files under its path from the thread's cwd, once per file", () => {
    const renamed = fileDiff("src/new.ts", { prevName: "src/old.ts", cacheKey: "key:pending" });
    const [placed] = placeRepositoryFiles([renamed], "../api");

    expect(placed).toMatchObject({
      name: "../api/src/new.ts",
      prevName: "../api/src/old.ts",
      cacheKey: "../api\u0000key:pending",
    });
    expect(placeRepositoryFiles([renamed], "../api")[0]).toBe(placed);
    expect(placeRepositoryFiles([renamed], "")[0]).toBe(renamed);
  });
});

describe("diffPanelRepositoryOptions", () => {
  it("keys home apart from tracked repos and keeps a repo opened from outside the list", () => {
    const outside = { key: "/code/infra", name: "infra", cwd: "/code/infra" };

    expect(
      diffPanelRepositoryOptions(workspace, outside).map((option) => [option.key, option.cwd]),
    ).toEqual([
      ["home", "/code/home"],
      ["/code/api", "/tasks/t1/api"],
      ["/code/infra", "/code/infra"],
    ]);
    expect(
      diffPanelRepositoryOptions(workspace, {
        key: "/code/api",
        name: "api",
        cwd: "/tasks/t1/api",
      }),
    ).toHaveLength(2);
    expect(diffPanelRepositoryOptions(null, undefined)).toEqual([]);
  });

  it("keeps the thread's own checkout when a single-repo thread reviews an outside repo", () => {
    const outside = { key: "/code/infra", name: "infra", cwd: "/code/infra" };
    expect(
      diffPanelRepositoryOptions(null, outside, { name: "web", cwd: "/tasks/t1/web" }).map(
        (option) => [option.key, option.cwd],
      ),
    ).toEqual([
      ["home", "/tasks/t1/web"],
      ["/code/infra", "/code/infra"],
    ]);
    // Going back to home leaves a single option, so the filter hides.
    expect(
      diffPanelRepositoryOptions(
        null,
        { key: "home", name: "web", cwd: "/tasks/t1/web" },
        { name: "web", cwd: "/tasks/t1/web" },
      ),
    ).toHaveLength(1);
  });
});
