import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveNewThreadModelSelectionOverride,
  shouldResetBranchForNewWorktree,
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

describe("shouldResetBranchForNewWorktree", () => {
  const input = {
    currentEnvMode: "local",
    nextEnvMode: "worktree",
    worktreeBaseBranch: "dev",
  } as const;

  it("starts a new worktree from the configured base instead of the checkout's branch", () => {
    expect(shouldResetBranchForNewWorktree(input)).toBe(true);
  });

  it("keeps a base already picked in worktree mode", () => {
    expect(shouldResetBranchForNewWorktree({ ...input, currentEnvMode: "worktree" })).toBe(false);
  });

  it("keeps today's behavior without a configured base or when leaving worktree mode", () => {
    expect(shouldResetBranchForNewWorktree({ ...input, worktreeBaseBranch: "" })).toBe(false);
    expect(
      shouldResetBranchForNewWorktree({
        currentEnvMode: "worktree",
        nextEnvMode: "local",
        worktreeBaseBranch: "dev",
      }),
    ).toBe(false);
  });
});
