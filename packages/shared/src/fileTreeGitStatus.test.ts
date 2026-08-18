import { describe, expect, it } from "vite-plus/test";

import { workingTreeGitStatusByPath } from "./fileTreeGitStatus.ts";

describe("workingTreeGitStatusByPath", () => {
  it("skips files that have no status so older servers stay decoration-free", () => {
    expect(
      workingTreeGitStatusByPath([{ path: "src/demo.ts", insertions: 1, deletions: 0 }]),
    ).toEqual(new Map());
  });

  it("keeps the caller's tree-path identity including Pierre directory slashes", () => {
    const byPath = workingTreeGitStatusByPath(
      [{ path: "src/new/", insertions: 0, deletions: 0, status: "untracked" }],
      ["src/", "src/index.ts", "src/new/", "src/new/foo.ts"],
    );

    expect(byPath.get("src/new/")).toBe("untracked");
    expect(byPath.get("src/new/foo.ts")).toBe("untracked");
    expect(byPath.get("src/")).toBe("untracked");
    expect(byPath.has("src/new")).toBe(false);
  });

  it("does not expand an untracked file across the rest of the tree", () => {
    const byPath = workingTreeGitStatusByPath(
      [{ path: "src/new.ts", insertions: 0, deletions: 0, status: "untracked" }],
      ["src/index.ts", "src/new.ts", "src/other.ts"],
    );

    expect(byPath.get("src/new.ts")).toBe("untracked");
    expect(byPath.get("src/index.ts")).toBeUndefined();
    expect(byPath.get("src/other.ts")).toBeUndefined();
  });

  it("does not let an untracked directory overwrite a more specific file status", () => {
    const byPath = workingTreeGitStatusByPath(
      [
        { path: "src/", insertions: 0, deletions: 0, status: "untracked" },
        { path: "src/keep.ts", insertions: 1, deletions: 0, status: "modified" },
      ],
      ["src/keep.ts", "src/new.ts"],
    );

    expect(byPath.get("src/keep.ts")).toBe("modified");
    expect(byPath.get("src/new.ts")).toBe("untracked");
    expect(byPath.get("src")).toBe("modified");
  });

  it("rolls the strongest child status up onto ancestor directories", () => {
    const byPath = workingTreeGitStatusByPath(
      [
        { path: "src/new/foo.ts", insertions: 0, deletions: 0, status: "untracked" },
        { path: "src/index.ts", insertions: 2, deletions: 1, status: "modified" },
      ],
      ["src/new/foo.ts", "src/index.ts"],
    );

    expect(byPath.get("src/index.ts")).toBe("modified");
    expect(byPath.get("src/new/foo.ts")).toBe("untracked");
    expect(byPath.get("src/new")).toBe("untracked");
    expect(byPath.get("src")).toBe("modified");
  });
});
