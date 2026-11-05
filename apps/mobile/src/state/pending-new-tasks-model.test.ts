import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePendingDraftBranch } from "./pending-new-tasks-model";
import type { ComposerDraft, ComposerDraftWorkspaceSelection } from "./use-composer-drafts";

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
  it("shows no branch for a draft that never picked one, so it starts on the checkout", () => {
    expect(
      resolvePendingDraftBranch({ draft: draft(), canChooseWorkspace: true, isGitRepo: true }),
    ).toBeNull();
  });

  it("keeps a chosen branch", () => {
    expect(
      resolvePendingDraftBranch({
        draft: draft({ branch: "release" }),
        canChooseWorkspace: true,
        isGitRepo: true,
      }),
    ).toBe("release");
  });

  it("ignores a stored selection when the workspace cannot be chosen", () => {
    expect(
      resolvePendingDraftBranch({
        draft: draft({ branch: "release" }),
        canChooseWorkspace: false,
        isGitRepo: true,
      }),
    ).toBeNull();
  });
});
