import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type PendingDraftProjectDefaults,
  pendingDraftBranchNeedsRefs,
  resolvePendingDraftBranch,
} from "./pending-new-tasks-model";
import type { ComposerDraft, ComposerDraftWorkspaceSelection } from "./use-composer-drafts";

const projectCwd = "/repo";
const localDefault: PendingDraftProjectDefaults = {
  canChooseWorkspace: true,
  defaultMode: "local",
  defaultModeSettled: true,
};
const worktreeDefault: PendingDraftProjectDefaults = { ...localDefault, defaultMode: "worktree" };
const resolve = (
  input: Omit<Parameters<typeof resolvePendingDraftBranch>[0], "defaults" | "isGitRepo"> & {
    readonly defaults?: PendingDraftProjectDefaults;
  },
) => resolvePendingDraftBranch({ defaults: localDefault, isGitRepo: true, ...input });
const branches = [
  { name: "feature", current: true, isDefault: false },
  { name: "origin/main", current: false, isDefault: true, isRemote: true },
];

function draft(workspaceSelection?: ComposerDraftWorkspaceSelection): ComposerDraft {
  return {
    text: "unsent",
    attachments: [],
    project: {
      environmentId: EnvironmentId.make("env-1"),
      projectId: ProjectId.make("project-1"),
      createdAt: "2026-10-26T00:00:00.000Z",
    },
    ...(workspaceSelection ? { workspaceSelection } : {}),
  };
}

describe("resolvePendingDraftBranch", () => {
  it("shows the project's default for a draft that never picked a mode", () => {
    const untouched = draft();
    expect(pendingDraftBranchNeedsRefs(untouched, worktreeDefault)).toBe(true);
    expect(resolve({ draft: untouched, defaults: worktreeDefault, branches, projectCwd })).toBe(
      "origin/main",
    );
    // Until t3.json settles, the environment default may still be replaced.
    expect(
      resolve({
        draft: untouched,
        defaults: { ...worktreeDefault, defaultModeSettled: false },
        branches,
        projectCwd,
      }),
    ).toBeNull();
    // A local default starts on the checkout without naming a branch, as on main.
    expect(pendingDraftBranchNeedsRefs(untouched, localDefault)).toBe(false);
    expect(resolve({ draft: untouched, branches, projectCwd })).toBeNull();
  });

  it("shows the default base for a worktree draft that never picked one", () => {
    const worktree = draft({ mode: "worktree", branch: null, worktreePath: null });
    expect(pendingDraftBranchNeedsRefs(worktree, localDefault)).toBe(true);
    expect(resolve({ draft: worktree, branches, projectCwd })).toBe("origin/main");
  });

  it("shows the current branch for a local draft that follows the checkout", () => {
    const local = draft({
      mode: "local",
      branch: null,
      worktreePath: null,
      followsCurrentCheckout: true,
    });
    expect(resolve({ draft: local, branches, projectCwd })).toBe("feature");
    expect(resolve({ draft: local, branches: [], projectCwd })).toBeNull();
  });

  it("keeps a chosen branch without loading refs", () => {
    const chosen = draft({ mode: "local", branch: "release", worktreePath: null });
    expect(pendingDraftBranchNeedsRefs(chosen, localDefault)).toBe(false);
    expect(resolve({ draft: chosen, branches, projectCwd })).toBe("release");
  });
});
