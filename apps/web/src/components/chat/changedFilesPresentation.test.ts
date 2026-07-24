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
});
