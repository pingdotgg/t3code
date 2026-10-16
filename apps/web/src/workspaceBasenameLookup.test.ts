import { describe, expect, it } from "vite-plus/test";

import {
  claimWorkspaceBasenameLookup,
  findWorkspaceFileMatch,
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  pickWorkspaceSuffixMatch,
  type WorkspaceEntryCandidate,
} from "./workspaceBasenameLookup";

describe("needsWorkspaceBasenameLookup", () => {
  it("flags bare filenames", () => {
    expect(needsWorkspaceBasenameLookup("ChatView.tsx")).toBe(true);
    expect(needsWorkspaceBasenameLookup("Makefile")).toBe(true);
  });

  it("leaves anything with a directory alone", () => {
    expect(needsWorkspaceBasenameLookup("apps/web/src/components/ChatView.tsx")).toBe(false);
    expect(needsWorkspaceBasenameLookup("apps\\web\\ChatView.tsx")).toBe(false);
    expect(needsWorkspaceBasenameLookup(".")).toBe(false);
    expect(needsWorkspaceBasenameLookup("..")).toBe(false);
    expect(needsWorkspaceBasenameLookup("   ")).toBe(false);
  });
});

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

describe("pickWorkspaceSuffixMatch", () => {
  it("finds the file a relative path names inside a subfolder", () => {
    expect(
      pickWorkspaceSuffixMatch("docs/GROUPS_PLAN.md", [
        { path: "BudgetLens/docs/GROUPS_PLAN.md", kind: "file" },
        { path: "BudgetLens/docs/other.md", kind: "file" },
      ]),
    ).toBe("BudgetLens/docs/GROUPS_PLAN.md");
  });

  it("matches whole segments only", () => {
    expect(
      pickWorkspaceSuffixMatch("docs/plan.md", [{ path: "src/mydocs/plan.md", kind: "file" }]),
    ).toBeNull();
  });

  it("accepts Windows separators on either side", () => {
    expect(
      pickWorkspaceSuffixMatch("lab\\out\\icon.png", [
        { path: "Docs/notes/lab/out/icon.png", kind: "file" },
      ]),
    ).toBe("Docs/notes/lab/out/icon.png");
  });

  it("resolves to nothing when two files share the suffix", () => {
    expect(
      pickWorkspaceSuffixMatch("docs/plan.md", [
        { path: "a/docs/plan.md", kind: "file" },
        { path: "b/docs/plan.md", kind: "file" },
      ]),
    ).toBeNull();
  });

  it("folds case only when no exact match exists", () => {
    expect(
      pickWorkspaceSuffixMatch("Docs/Plan.md", [{ path: "a/docs/plan.md", kind: "file" }]),
    ).toBe("a/docs/plan.md");
    expect(
      pickWorkspaceSuffixMatch("docs/plan.md", [
        { path: "a/docs/plan.md", kind: "file" },
        { path: "b/Docs/Plan.md", kind: "file" },
      ]),
    ).toBe("a/docs/plan.md");
  });

  it("trusts a truncated page only when a fuzzy file follows the match", () => {
    const match: WorkspaceEntryCandidate = { path: "apps/web/src/ChatMarkdown.tsx", kind: "file" };
    const fuzzy: WorkspaceEntryCandidate = { path: "apps/web/src/ChatMarkup.tsx", kind: "file" };
    expect(pickWorkspaceSuffixMatch("src/ChatMarkdown.tsx", [match, fuzzy], true)).toBe(match.path);
    // The page ends on the match, so the next page could hold another one.
    expect(pickWorkspaceSuffixMatch("src/ChatMarkdown.tsx", [fuzzy, match], true)).toBeNull();
    expect(pickWorkspaceSuffixMatch("src/ChatMarkdown.tsx", [fuzzy, match])).toBe(match.path);
  });

  it("ignores directories", () => {
    expect(
      pickWorkspaceSuffixMatch("src/components", [
        { path: "apps/src/components", kind: "directory" },
      ]),
    ).toBeNull();
  });
});

describe("findWorkspaceFileMatch", () => {
  const nestedPlan: WorkspaceEntryCandidate = {
    path: "BudgetLens/docs/GROUPS_PLAN.md",
    kind: "file",
  };
  const lookup = (
    literalExists: boolean,
    entries: ReadonlyArray<WorkspaceEntryCandidate> | null,
    truncated = false,
  ) => {
    const queries: string[] = [];
    return {
      queries,
      literalExists: async () => literalExists,
      searchFiles: async (query: string) => {
        queries.push(query);
        return entries ? { entries, truncated } : null;
      },
    };
  };

  it("keeps an existing literal path even when the index holds only a nested twin", async () => {
    // The literal root file can be gitignored, so the index cannot vouch for it.
    const deps = lookup(true, [nestedPlan]);
    await expect(findWorkspaceFileMatch("docs/GROUPS_PLAN.md", deps)).resolves.toBeNull();
    expect(deps.queries).toEqual([]);
  });

  it("opens the unique nested match when the literal path is missing", async () => {
    await expect(
      findWorkspaceFileMatch("docs/GROUPS_PLAN.md", lookup(false, [nestedPlan])),
    ).resolves.toBe("BudgetLens/docs/GROUPS_PLAN.md");
  });

  it("keeps the literal path when the missing file has no unique match", async () => {
    await expect(
      findWorkspaceFileMatch(
        "docs/GROUPS_PLAN.md",
        lookup(false, [nestedPlan, { path: "Other/docs/GROUPS_PLAN.md", kind: "file" }]),
      ),
    ).resolves.toBeNull();
    await expect(
      findWorkspaceFileMatch("docs/GROUPS_PLAN.md", lookup(false, null)),
    ).resolves.toBeNull();
  });

  it("passes a truncated page through to the suffix pick", async () => {
    const fuzzy: WorkspaceEntryCandidate = { path: "docs/GROUPS_PLAN.old.md", kind: "file" };
    await expect(
      findWorkspaceFileMatch("docs/GROUPS_PLAN.md", lookup(false, [nestedPlan, fuzzy], true)),
    ).resolves.toBe("BudgetLens/docs/GROUPS_PLAN.md");
    await expect(
      findWorkspaceFileMatch("docs/GROUPS_PLAN.md", lookup(false, [fuzzy, nestedPlan], true)),
    ).resolves.toBeNull();
  });

  it("still sends a bare name straight to the index", async () => {
    const deps = lookup(true, [{ path: "apps/web/src/ChatView.tsx", kind: "file" }]);
    await expect(findWorkspaceFileMatch("ChatView.tsx", deps)).resolves.toBe(
      "apps/web/src/ChatView.tsx",
    );
    expect(deps.queries).toEqual(["ChatView.tsx"]);
  });

  it("leaves workspace-root links alone", async () => {
    const deps = lookup(false, [nestedPlan]);
    await expect(findWorkspaceFileMatch(".", deps)).resolves.toBeNull();
    expect(deps.queries).toEqual([]);
  });
});

describe("claimWorkspaceBasenameLookup", () => {
  it("keeps only the newest claim, whatever order the lookups settle in", () => {
    const first = claimWorkspaceBasenameLookup();
    const second = claimWorkspaceBasenameLookup();

    // The older lookup answering last must not reopen the panel behind the
    // newer one.
    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });

  it("stays valid while it is the only claim", () => {
    const only = claimWorkspaceBasenameLookup();
    expect(only()).toBe(true);
  });
});
