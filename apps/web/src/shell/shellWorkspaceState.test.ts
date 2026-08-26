import { describe, expect, it } from "vite-plus/test";
import type { EditorId, ProjectScript, VcsStatusResult } from "@t3tools/contracts";

import { buildShellWorkspaceState } from "./shellWorkspaceState";

const gitStatus = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feat/x",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 2,
  behindCount: 0,
  pr: { number: 12, title: "Feature X", url: "https://example.test/pr/12", state: "open" },
} as unknown as VcsStatusResult;

const script = { id: "dev", name: "Dev server", command: "vp run dev" } as ProjectScript;

function baseInput() {
  return {
    threadKey: "env:thread",
    projectTitle: "t3code",
    projectRoot: "/repo",
    threadTitle: "Feature X",
    isDraft: false,
    envMode: "worktree" as const,
    envModeChangeable: false,
    startFromOrigin: false,
    branch: "feat/x",
    worktreePath: "/repo/.worktrees/x",
    gitStatus,
    canOpenPullRequest: true,
    availableEditors: ["vscode", "zed"] as EditorId[],
    preferredEditorId: "zed" as EditorId,
    scripts: [script],
    preferredScriptId: "dev",
    environments: [{ environmentId: "env", label: "Local" }],
    activeEnvironmentId: "env",
    environmentChangeable: false,
  };
}

describe("buildShellWorkspaceState", () => {
  it("labels a locked worktree checkout and projects git, editors and scripts", () => {
    const state = buildShellWorkspaceState(baseInput());
    expect(state.envModeLabel).toBe("Worktree");
    expect(state.git).toEqual({
      isRepo: true,
      hasWorkingTreeChanges: true,
      aheadCount: 2,
      behindCount: 0,
      hasUpstream: true,
      pullRequest: {
        number: 12,
        title: "Feature X",
        url: "https://example.test/pr/12",
        state: "open",
      },
    });
    expect(state.canOpenPullRequest).toBe(true);
    expect(state.editors).toEqual([
      { id: "vscode", label: "VS Code" },
      { id: "zed", label: "Zed" },
    ]);
    expect(state.scripts).toEqual([{ id: "dev", name: "Dev server", command: "vp run dev" }]);
  });

  it("labels a changeable checkout by mode and drops the PR affordance without a PR", () => {
    const state = buildShellWorkspaceState({
      ...baseInput(),
      envModeChangeable: true,
      envMode: "local",
      gitStatus: { ...gitStatus, pr: null } as VcsStatusResult,
    });
    expect(state.envModeLabel).toBe("Current checkout");
    expect(state.canOpenPullRequest).toBe(false);
    expect(state.git?.pullRequest).toBeNull();
  });

  it("handles missing git status", () => {
    expect(buildShellWorkspaceState({ ...baseInput(), gitStatus: null }).git).toBeNull();
  });
});
