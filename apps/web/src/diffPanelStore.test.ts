import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadBranchBaseRef,
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
} from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT_SHA = "89abcdef0123456789abcdef0123456789abcdef";

describe("diffPanelStore", () => {
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      diffRenderMode: "stacked",
    }),
  );

  it("keeps the selected render mode in panel and persisted state", async () => {
    useDiffPanelStore.getState().setDiffRenderMode("split");

    expect(useDiffPanelStore.getState().diffRenderMode).toBe("split");
    expect(
      useDiffPanelStore.persist.getOptions().partialize?.(useDiffPanelStore.getState()),
    ).toMatchObject({ diffRenderMode: "split" });

    const { name, storage } = useDiffPanelStore.persist.getOptions();
    if (!name) throw new Error("Expected diff panel persistence to have a storage name");
    const persisted = await storage?.getItem(name);
    expect(persisted?.state).toMatchObject({ diffRenderMode: "split" });

    useDiffPanelStore.setState({ diffRenderMode: "stacked" });
    if (persisted) await storage?.setItem(name, persisted);
    await useDiffPanelStore.persist.rehydrate();

    expect(useDiffPanelStore.getState().diffRenderMode).toBe("split");
  });

  it("defaults each thread to branch changes when the working tree is clean", () => {
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("defaults each thread to working changes when the working tree is dirty", () => {
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF, true),
    ).toEqual({ kind: "unstaged" });
  });

  it("preserves an explicit scope selection when the working tree state changes", () => {
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF, true),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("clears incompatible selection fields when changing scopes", () => {
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, TurnId.make("turn-1"), "src/app.ts");
    store.selectGitScope(THREAD_REF, "unstaged");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });

    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, " origin/main ");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("increments the reveal request when opening the same turn file again", () => {
    const turnId = TurnId.make("turn-1");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "turn", turnId, filePath: "src/app.ts", revealRequestId: 2 });
  });

  it("restores the selected branch base after visiting another scope", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("keeps the branch base while a commit is selected and after leaving it", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main");
    useDiffPanelStore.getState().selectCommit(THREAD_REF, COMMIT_SHA);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "commit", commitSha: COMMIT_SHA, baseRef: "origin/main" });

    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("falls back to branch changes when a selected commit leaves the branch range", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main");
    useDiffPanelStore.getState().selectCommit(THREAD_REF, COMMIT_SHA);
    useDiffPanelStore.getState().reconcileCommitSelection(THREAD_REF, [OTHER_COMMIT_SHA], true);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("keeps a commit selection that is still in the branch range", () => {
    useDiffPanelStore.getState().selectCommit(THREAD_REF, COMMIT_SHA);
    useDiffPanelStore
      .getState()
      .reconcileCommitSelection(THREAD_REF, [OTHER_COMMIT_SHA, COMMIT_SHA], true);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "commit", commitSha: COMMIT_SHA, baseRef: null });
  });

  it("keeps a commit selection when the listed commits are capped", () => {
    useDiffPanelStore.getState().selectCommit(THREAD_REF, COMMIT_SHA);
    useDiffPanelStore.getState().reconcileCommitSelection(THREAD_REF, [OTHER_COMMIT_SHA], false);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "commit", commitSha: COMMIT_SHA, baseRef: null });
  });

  it("falls back to branch changes when the branch range is completely empty", () => {
    useDiffPanelStore.getState().selectCommit(THREAD_REF, COMMIT_SHA);
    useDiffPanelStore.getState().reconcileCommitSelection(THREAD_REF, [], true);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("scopes a commit picked during a turn to the remembered branch base", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, TurnId.make("turn-1"));

    // The commit list is fetched against this base, so the selection it produces has to
    // name the same one or reconciliation would immediately reject the picked commit.
    expect(
      selectThreadBranchBaseRef(useDiffPanelStore.getState().branchBaseRefByThreadKey, THREAD_REF),
    ).toBe("origin/main");

    useDiffPanelStore.getState().selectCommit(THREAD_REF, COMMIT_SHA);
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "commit", commitSha: COMMIT_SHA, baseRef: "origin/main" });
  });

  it("reconciles a missing turn selection to the latest available turn", () => {
    const missingTurnId = TurnId.make("turn-missing");
    const latestTurnId = TurnId.make("turn-latest");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, missingTurnId, "src/app.ts");
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [latestTurnId]);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "turn",
      turnId: latestTurnId,
      filePath: "src/app.ts",
      revealRequestId: 1,
    });
  });
});
