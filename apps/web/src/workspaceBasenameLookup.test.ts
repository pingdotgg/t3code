import { describe, expect, it } from "vite-plus/test";

import {
  claimWorkspaceBasenameLookup,
  pickNestedWorkspaceMatch,
  pickWorkspaceBasenameMatch,
} from "@t3tools/client-runtime/workspace-basename-lookup";

describe("pickWorkspaceBasenameMatch", () => {
  const entries = [
    { path: "apps/web/src/components/ChatView.test.tsx", kind: "file" as const },
    { path: "apps/web/src/components/ChatView.tsx", kind: "file" as const },
  ];

  it("takes the first exact filename match, not the closest fuzzy one", () => {
    expect(pickWorkspaceBasenameMatch("ChatView.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  // regression: #6297 a bare filename resolves to a file, never a same-named directory
  it("ignores directories", () => {
    expect(
      pickWorkspaceBasenameMatch("components", [
        { path: "apps/web/src/components", kind: "directory" },
        { path: "apps/web/src/components/components", kind: "file" },
      ]),
    ).toBe("apps/web/src/components/components");
  });

  it("prefers the exactly-cased file over a case-only twin", () => {
    expect(
      pickWorkspaceBasenameMatch("foo.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBe("src/foo.ts");
  });

  it("falls back to case-insensitive when only the casing differs", () => {
    expect(pickWorkspaceBasenameMatch("chatview.tsx", entries)).toBe(
      "apps/web/src/components/ChatView.tsx",
    );
  });

  it("returns null when the case-insensitive fallback is ambiguous", () => {
    expect(
      pickWorkspaceBasenameMatch("FOO.ts", [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
      ]),
    ).toBeNull();
  });
});

describe("claimWorkspaceBasenameLookup", () => {
  it("keeps only the newest claim, whatever order the lookups settle in", () => {
    const first = claimWorkspaceBasenameLookup();
    const second = claimWorkspaceBasenameLookup();

    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });
});

describe("pickNestedWorkspaceMatch", () => {
  const cwd = "/Users/dev/workspace";

  it("finds a repository-relative path inside a nested repository", () => {
    expect(
      pickNestedWorkspaceMatch("docs/STATUS.md", cwd, [
        { path: "repo/docs/STATUS-old.md", kind: "file" },
        { path: "repo/docs/STATUS.md", kind: "file" },
      ]),
    ).toBe("repo/docs/STATUS.md");
  });

  it("prefers the shallowest copy over worktree copies deeper down", () => {
    expect(
      pickNestedWorkspaceMatch("docs/STATUS.md", cwd, [
        { path: "worktrees/lane-a/docs/STATUS.md", kind: "file" },
        { path: "repo/docs/STATUS.md", kind: "file" },
        { path: "worktrees/lane-b/docs/STATUS.md", kind: "file" },
      ]),
    ).toBe("repo/docs/STATUS.md");
  });

  it("keeps search rank between equally shallow copies", () => {
    expect(
      pickNestedWorkspaceMatch("docs/STATUS.md", cwd, [
        { path: "worktrees/lane-a/docs/STATUS.md", kind: "file" },
        { path: "repo-a/docs/STATUS.md", kind: "file" },
        { path: "repo-b/docs/STATUS.md", kind: "file" },
      ]),
    ).toBe("repo-a/docs/STATUS.md");
  });

  it("matches whole path segments only, and never directories", () => {
    expect(
      pickNestedWorkspaceMatch("docs/STATUS.md", cwd, [
        { path: "repo/mydocs/STATUS.md", kind: "file" },
        { path: "repo/docs/STATUS.md", kind: "directory" },
      ]),
    ).toBeNull();
  });

  it("folds case only for Windows workspaces", () => {
    const entries = [{ path: "repo\\Docs\\Status.md", kind: "file" as const }];
    expect(pickNestedWorkspaceMatch("docs/status.md", "C:\\work", entries)).toBe(
      "repo\\Docs\\Status.md",
    );
    expect(pickNestedWorkspaceMatch("docs/status.md", cwd, entries)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(pickNestedWorkspaceMatch("docs/STATUS.md", cwd, [])).toBeNull();
  });
});
