import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveNewThreadModelSelectionOverride,
  shouldClearSyncedDraftBranch,
} from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });
});

describe("shouldClearSyncedDraftBranch", () => {
  const input = {
    nextEnvMode: "worktree",
    worktreeBaseBranch: "dev",
    draftBranch: "feature/checked-out",
    environmentSelection: "auto",
  } as const;

  it("drops the checkout branch so a new worktree starts from the configured base", () => {
    expect(shouldClearSyncedDraftBranch(input)).toBe(true);
    expect(shouldClearSyncedDraftBranch({ ...input, environmentSelection: undefined })).toBe(true);
  });

  it("keeps a branch the user picked", () => {
    expect(shouldClearSyncedDraftBranch({ ...input, environmentSelection: "manual" })).toBe(false);
  });

  it("keeps today's behavior without a configured base or outside worktree mode", () => {
    expect(shouldClearSyncedDraftBranch({ ...input, worktreeBaseBranch: "" })).toBe(false);
    expect(shouldClearSyncedDraftBranch({ ...input, nextEnvMode: "local" })).toBe(false);
  });
});
