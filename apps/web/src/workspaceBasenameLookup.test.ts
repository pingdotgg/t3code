import { describe, expect, it } from "vite-plus/test";

import {
  claimWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
} from "./workspaceBasenameLookup";

describe("pickWorkspaceBasenameMatch", () => {
  const entries = [
    { path: "apps/web/src/components/ChatView.test.tsx", kind: "file" as const },
    { path: "apps/web/src/components/ChatView.tsx", kind: "file" as const },
  ];

  it("takes the first exact filename match, not the closest fuzzy one", () => {
    expect(
      pickWorkspaceBasenameMatch("ChatView.tsx", [
        ...entries,
        { path: "apps/desktop/src/ChatView.tsx", kind: "file" },
      ]),
    ).toBe("apps/web/src/components/ChatView.tsx");
  });

  it("matches a slashed path as a suffix wherever it actually lives", () => {
    expect(
      pickWorkspaceBasenameMatch("docs/GROUPS_PLAN.md", [
        { path: "BudgetLens/docs/GROUPS_PLAN.md", kind: "file" },
        { path: "docs/other.md", kind: "file" },
      ]),
    ).toBe("BudgetLens/docs/GROUPS_PLAN.md");
  });

  it("does not let a suffix match straddle a segment boundary", () => {
    expect(
      pickWorkspaceBasenameMatch("docs/plan.md", [{ path: "src/mydocs/plan.md", kind: "file" }]),
    ).toBeNull();
    expect(
      pickWorkspaceBasenameMatch("plan.md", [{ path: "src/plan.md.bak", kind: "file" }]),
    ).toBeNull();
  });

  it("prefers the exact suffix over a basename-only twin", () => {
    expect(
      pickWorkspaceBasenameMatch("docs/plan.md", [
        { path: "other/plan.md", kind: "file" },
        { path: "BudgetLens/docs/plan.md", kind: "file" },
      ]),
    ).toBe("BudgetLens/docs/plan.md");
  });

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

  it("returns null when nothing matches the name", () => {
    expect(pickWorkspaceBasenameMatch("ChatView.tsx", [])).toBeNull();
    expect(
      pickWorkspaceBasenameMatch("ChatView.tsx", [
        { path: "apps/web/src/components/ChatHeader.tsx", kind: "file" },
      ]),
    ).toBeNull();
  });
});

describe("claimWorkspaceBasenameLookup", () => {
  it("keeps only the newest claim, whatever order the lookups settle in", () => {
    const first = claimWorkspaceBasenameLookup("thread-a");
    const second = claimWorkspaceBasenameLookup("thread-a");

    // The older lookup answering last must not reopen the panel behind the
    // newer one.
    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });

  it("stays valid while it is the only claim", () => {
    const only = claimWorkspaceBasenameLookup("thread-a");
    expect(only()).toBe(true);
  });

  it("keeps another thread's in-flight claim valid", () => {
    const threadA = claimWorkspaceBasenameLookup("thread-a");
    claimWorkspaceBasenameLookup("thread-b");
    expect(threadA()).toBe(true);
  });
});
