import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  inferThreadFolderRule,
  threadFolderIcon,
  pickThreadFolderForRule,
  threadFolderRuleHasConditions,
  threadMatchesFolderRule,
  threadNamesFolder,
} from "./threadFolderRule.ts";

const thread = {
  projectId: ProjectId.make("project:web"),
  title: "Review PR 12165: status dropdown",
  branch: "t3code/fix-status-dropdown",
  worktreePath: "/root/.t3/worktrees/t3code/fix-status-dropdown",
  providerInstanceId: ProviderInstanceId.make("codex"),
  hasPullRequest: true,
};

describe("threadMatchesFolderRule", () => {
  it("counts only enabled smart rules as conditions", () => {
    expect(threadFolderRuleHasConditions({ smart: true })).toBe(true);
    expect(threadFolderRuleHasConditions({ smart: false })).toBe(false);
  });
  it.each([
    [{}, false],
    [{ smart: true }, false],
    [{ smart: true, branches: ["t3code/fix-*"] }, true],
    [{ smart: true, pullRequest: true }, false],
    [{ branches: ["t3code/fix-*"] }, true],
    [{ branches: ["T3CODE/FIX-STATUS-DROPDOWN"] }, true],
    [{ branches: ["main"] }, false],
    [{ worktrees: ["fix-status-*"] }, true],
    [{ worktrees: ["/root/.t3/worktrees/*"] }, true],
    [{ branches: ["main"], worktrees: ["fix-status-*"] }, true],
    [{ branches: ["main"], worktrees: ["other"] }, false],
    [{ titleKeywords: ["review", "audit"] }, true],
    [{ titleKeywords: ["audit"] }, false],
    [{ titleKeywords: ["view"] }, false],
    [{ titleKeywords: ["revie"] }, true],
    [{ titleKeywords: ["pr 12165"] }, true],
    [{ titleKeywords: ["status dropdown"] }, true],
    [{ pullRequest: true }, true],
    [{ pullRequest: false }, false],
    [{ projectIds: [ProjectId.make("project:web")], titleKeywords: ["review"] }, true],
    [{ projectIds: [ProjectId.make("project:mobile")], titleKeywords: ["review"] }, false],
    [{ providerInstanceIds: [ProviderInstanceId.make("claudeAgent")] }, false],
    [{ branches: ["a.b"] }, false],
  ])("%j matches: %s", (rule, expected) => {
    expect(threadMatchesFolderRule(rule, thread)).toBe(expected);
  });

  it("matches hostile globs without backtracking", () => {
    const branch = "a".repeat(5_000);
    expect(
      threadMatchesFolderRule({ branches: ["*a".repeat(40) + "b"] }, { ...thread, branch }),
    ).toBe(false);
    expect(threadMatchesFolderRule({ branches: ["*a*a*"] }, { ...thread, branch })).toBe(true);
  });

  it("never matches a missing branch or worktree", () => {
    const bare = { ...thread, branch: null, worktreePath: null };
    expect(threadMatchesFolderRule({ branches: ["*"] }, bare)).toBe(false);
    expect(threadMatchesFolderRule({ worktrees: ["*"] }, bare)).toBe(false);
  });
});

describe("pickThreadFolderForRule", () => {
  it("takes the first enabled match in folder order", () => {
    const folders = [
      { id: "smart", rule: { smart: true, pullRequest: true }, autoFile: true },
      { id: "off", rule: { pullRequest: true }, autoFile: false },
      { id: "none", rule: null, autoFile: true },
      { id: "elsewhere", rule: { smart: true, branches: ["main"] }, autoFile: true },
      { id: "reviews", rule: { titleKeywords: ["review"] }, autoFile: true },
      { id: "prs", rule: { pullRequest: true }, autoFile: true },
    ];
    expect(pickThreadFolderForRule(folders, thread)?.id).toBe("reviews");
    expect(pickThreadFolderForRule(folders, { ...thread, branch: "main" })?.id).toBe("elsewhere");
    expect(pickThreadFolderForRule(folders, { ...thread, title: "x", hasPullRequest: false })).toBe(
      null,
    );
  });
});

describe("inferThreadFolderRule", () => {
  it.each([
    ["Fix status dropdown", { branches: ["t3code/fix-status-dropdown"] }],
    ["t3code/fix-status-dropdown", { branches: ["t3code/fix-status-dropdown"] }],
    ["Fix status", null],
    ["Reviews", null],
  ])("%s collects %j", (name, expected) => {
    expect(inferThreadFolderRule(name, [thread])).toEqual(expected);
  });

  it("needs every thread on the branch, so a feature folder spanning branches stays by topic", () => {
    expect(
      inferThreadFolderRule("Fix status dropdown", [
        thread,
        { ...thread, branch: "main", worktreePath: null },
      ]),
    ).toBeNull();
  });

  it("falls back to a worktree name", () => {
    expect(inferThreadFolderRule("Fix status dropdown", [{ ...thread, branch: "main" }])).toEqual({
      worktrees: ["fix-status-dropdown"],
    });
  });
});

describe("threadNamesFolder", () => {
  const subject = { ...thread, projectName: "fleet" };
  it.each([
    ["Fleet", true],
    ["fix status dropdown", true],
    ["Status dropdown", true],
    ["Mobile changes", false],
    ["Drop", false],
    ["", false],
  ])("%j: %s", (name, expected) => {
    expect(threadNamesFolder(name, subject)).toBe(expected);
  });
});

describe("threadFolderIcon", () => {
  it.each([
    ["T3 Code mobile changes", "smartphone", "blue"],
    ["Fleet agents", "bot", "green"],
    ["Bug fixes", "bug", "red"],
    ["Design fixes", "palette", "pink"],
    ["Previews", "folder", "gray"],
  ])("%s gets %s in %s", (name, icon, color) => {
    expect(threadFolderIcon(name)).toEqual({ kind: "lucide", name: icon, color });
  });
});
