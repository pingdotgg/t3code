import { describe, expect, it } from "bun:test";

import type { VcsStatusResult } from "@t3tools/contracts";
import { buildGitMenuItems, resolveGitQuickAction } from "./gitActions.logic.ts";

const status = (over: Partial<VcsStatusResult>): VcsStatusResult =>
  ({
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/x",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...over,
  }) as unknown as VcsStatusResult;

const openPr = { number: 7, title: "x", url: "https://example/pr/7", baseRef: "main", headRef: "feature/x", state: "open" };

describe("resolveGitQuickAction", () => {
  it("Given a busy state, then it shows a disabled in-progress hint", () => {
    const action = resolveGitQuickAction(status({}), true);
    expect(action).toMatchObject({ kind: "show_hint", disabled: true });
  });

  it("Given working-tree changes on a feature branch with upstream, then it offers Commit, push & PR", () => {
    const action = resolveGitQuickAction(status({ hasWorkingTreeChanges: true }), false);
    expect(action).toMatchObject({ kind: "run_action", action: "commit_push_pr", label: "Commit, push & PR" });
  });

  it("Given ahead of upstream with no PR, then it offers Push & create PR", () => {
    const action = resolveGitQuickAction(status({ aheadCount: 2 }), false);
    expect(action).toMatchObject({ kind: "run_action", action: "create_pr", label: "Push & create PR" });
  });

  it("Given an open PR that is up to date, then it offers View PR", () => {
    const action = resolveGitQuickAction(status({ pr: openPr as never }), false);
    expect(action).toMatchObject({ kind: "open_pr", label: "View PR" });
  });

  it("Given behind upstream, then it offers Pull", () => {
    const action = resolveGitQuickAction(status({ behindCount: 1 }), false);
    expect(action).toMatchObject({ kind: "run_pull", label: "Pull" });
  });

  it("Given no upstream and no commits, then Push is disabled with a hint", () => {
    const action = resolveGitQuickAction(status({ hasUpstream: false, aheadCount: 0 }), false);
    expect(action).toMatchObject({ kind: "show_hint", label: "Push", disabled: true });
  });
});

describe("buildGitMenuItems", () => {
  it("Given a feature branch ahead with no PR, then Create PR is enabled and View PR is absent", () => {
    const items = buildGitMenuItems(status({ aheadCount: 2 }), false);
    expect(items.map((i) => i.label)).toEqual(["Commit", "Push", "Create PR"]);
    const pr = items.find((i) => i.id === "pr");
    expect(pr).toMatchObject({ label: "Create PR", action: "create_pr", disabled: false });
    expect(items.find((i) => i.id === "push")?.disabled).toBe(false);
  });

  it("Given an open PR, then the PR item becomes a clickable View PR with the url", () => {
    const items = buildGitMenuItems(status({ pr: openPr as never }), false);
    const pr = items.find((i) => i.id === "pr");
    expect(pr).toMatchObject({ label: "View PR", action: null, openUrl: "https://example/pr/7" });
  });

  it("Given no primary remote, then only Commit is offered", () => {
    const items = buildGitMenuItems(status({ hasPrimaryRemote: false }), false);
    expect(items.map((i) => i.label)).toEqual(["Commit"]);
  });

  it("Given a busy state, then every actionable item is disabled", () => {
    const items = buildGitMenuItems(status({ hasWorkingTreeChanges: true, aheadCount: 2 }), true);
    expect(items.every((i) => i.disabled)).toBe(true);
  });
});
