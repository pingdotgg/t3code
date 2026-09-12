import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  it("keeps repeatable diff selections and branch bases independent", () => {
    const secondPanel = { ...THREAD_REF, surfaceId: "diff:2" };
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/main");
    store.selectBranchBaseRef(secondPanel, "origin/release");
    store.selectGitScope(secondPanel, "unstaged");
    store.selectTurn(THREAD_REF, TurnId.make("turn-1"));
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, secondPanel),
    ).toEqual({ kind: "unstaged" });
    store.selectGitScope(secondPanel, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, secondPanel),
    ).toEqual({ kind: "branch", baseRef: "origin/release" });
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ kind: "turn", turnId: "turn-1" });
  });

  it("removes one closed diff instance without resetting the others", () => {
    const secondPanel = { ...THREAD_REF, surfaceId: "diff:2" };
    const store = useDiffPanelStore.getState();
    store.selectGitScope(THREAD_REF, "unstaged");
    store.selectBranchBaseRef(secondPanel, "origin/release");
    store.removeSurface(secondPanel);
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, secondPanel),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("removes every diff instance when its thread is removed", () => {
    const store = useDiffPanelStore.getState();
    const otherThread = scopeThreadRef(THREAD_REF.environmentId, ThreadId.make("other-thread"));
    store.selectBranchBaseRef(THREAD_REF, "origin/main");
    store.selectBranchBaseRef({ ...THREAD_REF, surfaceId: "diff:2" }, "origin/release");
    store.selectGitScope(otherThread, "unstaged");
    store.removeThread(THREAD_REF);
    expect(Object.values(useDiffPanelStore.getState().byThreadKey)).toEqual([{ kind: "unstaged" }]);
    expect(useDiffPanelStore.getState().branchBaseRefByThreadKey).toEqual({});
  });
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    }),
  );

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
