import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { panelAtom } from "../browser/panel";
import { openTicketChanges, previewInput } from "./changesView";
import { filesViewAtom } from "./filesView";

describe("openTicketChanges", () => {
  it("Given a ticket with a worktree, when its changes open, then the Source Control tab shows that root and its branch diff opens in the main view", () => {
    const registry = AtomRegistry.make();

    openTicketChanges(registry, { worktreePath: "/work/trees/t-1/", base: "main" });

    expect(registry.get(panelAtom)).toMatchObject({ open: true, tab: "changes" });
    expect(registry.get(filesViewAtom)).toMatchObject({
      root: "/work/trees/t-1",
      active: { cwd: "/work/trees/t-1", path: "", diff: { kind: "branch-range", baseRef: "main" } },
    });
  });

  it("Given a ticket with no worktree, when its changes open, then nothing changes", () => {
    const registry = AtomRegistry.make();

    openTicketChanges(registry, { worktreePath: null, base: "main" });

    expect(registry.get(filesViewAtom).tabs).toEqual([]);
    expect(registry.get(panelAtom).tab).toBe("chat");
  });
});

describe("previewInput", () => {
  it("Given each source, when the request is built, then commits go by sha and branch ranges carry their base", () => {
    expect(previewInput("/p", { kind: "working-tree" }, false)).toEqual({
      cwd: "/p",
      sourceKind: "working-tree",
      ignoreWhitespace: false,
    });
    expect(previewInput("/p", { kind: "branch-range", baseRef: "main" }, true)).toEqual({
      cwd: "/p",
      sourceKind: "branch-range",
      ignoreWhitespace: true,
      baseRef: "main",
    });
    expect(previewInput("/p", { kind: "branch-range", baseRef: null }, false)).not.toHaveProperty(
      "baseRef",
    );
    expect(previewInput("/p", { kind: "commit", sha: "abc" }, false)).toEqual({
      cwd: "/p",
      commitSha: "abc",
      ignoreWhitespace: false,
    });
  });
});
