import { describe, expect, it } from "vite-plus/test";

import {
  changedFileName,
  selectChangedFilePreview,
  shouldAutoExpandChangedFiles,
  summarizeChangedFileScopes,
} from "./changedFilesPresentation";

describe("changed-files presentation", () => {
  it("auto-expands only small, low-churn latest changes", () => {
    const smallFiles = [
      { path: "src/a.ts", kind: "modified", additions: 80, deletions: 20 },
      { path: "src/b.ts", kind: "modified", additions: 60, deletions: 20 },
    ];

    expect(shouldAutoExpandChangedFiles(smallFiles, true)).toBe(true);
    expect(shouldAutoExpandChangedFiles(smallFiles, false)).toBe(false);
    expect(
      shouldAutoExpandChangedFiles(
        [{ path: "src/a.ts", kind: "modified", additions: 201, deletions: 0 }],
        true,
      ),
    ).toBe(false);
    expect(
      shouldAutoExpandChangedFiles(
        Array.from({ length: 6 }, (_, index) => ({
          path: `src/${index}.ts`,
          kind: "modified",
          additions: 1,
          deletions: 0,
        })),
        true,
      ),
    ).toBe(false);
  });

  it("summarizes the most prominent top-level scopes", () => {
    const files = [
      { path: "apps/web/src/App.tsx", kind: "modified", additions: 1, deletions: 0 },
      { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
      { path: "apps/server/src/index.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "packages/shared/src/git.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "apps\\mobile\\App.tsx", kind: "modified", additions: 1, deletions: 0 },
    ];

    expect(summarizeChangedFileScopes(files)).toEqual([
      { label: "apps", fileCount: 3 },
      { label: "root", fileCount: 1 },
      { label: "packages", fileCount: 1 },
    ]);
  });

  it("previews files across different scopes before filling from one scope", () => {
    const files = [
      { path: "apps/web/src/App.tsx", kind: "modified", additions: 1, deletions: 0 },
      { path: "apps/web/src/App.test.tsx", kind: "modified", additions: 1, deletions: 0 },
      { path: "packages/shared/src/git.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
    ];

    expect(selectChangedFilePreview(files).map((file) => file.path)).toEqual([
      "apps/web/src/App.tsx",
      "packages/shared/src/git.ts",
      "README.md",
    ]);
    expect(changedFileName("apps\\web\\src\\App.tsx")).toBe("App.tsx");
  });

  it("uses repository scopes and keeps same-named files from different repositories", () => {
    const files = [
      {
        path: "README.md",
        repoRoot: "/workspace/frontend",
        kind: "modified",
        additions: 1,
        deletions: 0,
      },
      {
        path: "README.md",
        repoRoot: "/workspace/backend",
        kind: "modified",
        additions: 1,
        deletions: 0,
      },
    ];

    expect(summarizeChangedFileScopes(files)).toEqual([
      { label: "frontend", fileCount: 1 },
      { label: "backend", fileCount: 1 },
    ]);
    expect(selectChangedFilePreview(files)).toEqual(files);
  });

  it("keeps repositories with matching basenames as distinct scopes", () => {
    const files = [
      {
        path: "README.md",
        repoRoot: "/clients/a/app",
        kind: "modified",
        additions: 1,
        deletions: 0,
      },
      {
        path: "package.json",
        repoRoot: "/clients/b/app",
        kind: "modified",
        additions: 1,
        deletions: 0,
      },
    ];

    expect(summarizeChangedFileScopes(files)).toEqual([
      { label: "a/app", fileCount: 1 },
      { label: "b/app", fileCount: 1 },
    ]);
    expect(selectChangedFilePreview(files)).toEqual(files);
  });
});
