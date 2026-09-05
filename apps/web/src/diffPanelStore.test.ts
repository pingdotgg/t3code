import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  EMPTY_COLLAPSED_DIFF_FILE_KEYS,
  selectCollapsedDiffFileKeys,
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
} from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      collapsedFileKeysByScopeKey: {},
      viewportByScopeKey: {},
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

  it("isolates collapsed files by scope without persisting them across reloads", () => {
    const scopeKey = "environment-1:thread-1:turn:turn-1";
    const fileKeys = new Set(["src/components/game-stats.tsx"]);
    useDiffPanelStore.getState().setCollapsedFileKeys(scopeKey, fileKeys);

    expect(
      selectCollapsedDiffFileKeys(
        useDiffPanelStore.getState().collapsedFileKeysByScopeKey,
        scopeKey,
      ),
    ).toEqual(fileKeys);
    expect(
      selectCollapsedDiffFileKeys(
        useDiffPanelStore.getState().collapsedFileKeysByScopeKey,
        "environment-1:thread-1:unstaged",
      ),
    ).toBe(EMPTY_COLLAPSED_DIFF_FILE_KEYS);
    expect(
      useDiffPanelStore.persist.getOptions().partialize?.(useDiffPanelStore.getState()),
    ).not.toHaveProperty("collapsedFileKeysByScopeKey");
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

  it("keeps viewport captures session-only and isolated from another review scope", () => {
    const scopeKey = "environment-1:thread-1:unstaged";
    const viewport = { scrollTop: 1300, revealSelection: null };
    useDiffPanelStore.getState().setViewport(scopeKey, viewport);

    expect(useDiffPanelStore.getState().viewportByScopeKey[scopeKey]).toEqual(viewport);
    expect(
      useDiffPanelStore.getState().viewportByScopeKey["environment-1:thread-1:branch"],
    ).toBeUndefined();
    expect(
      useDiffPanelStore.persist.getOptions().partialize?.(useDiffPanelStore.getState()),
    ).not.toHaveProperty("viewportByScopeKey");
  });

  it.each([false, true])("removes all thread scopes with an explicit selection: %s", (selected) => {
    const store = useDiffPanelStore.getState();
    if (selected) store.selectBranchBaseRef(THREAD_REF, "origin/main");
    const removedScopes = ["environment-1:thread-1:unstaged", "environment-1:thread-1:turn:turn-1"];
    const retainedScopes = ["environment-2:thread-1:unstaged", "environment-1:thread-10:unstaged"];
    for (const scopeKey of [...removedScopes, ...retainedScopes]) {
      store.setCollapsedFileKeys(scopeKey, new Set(["old.ts"]));
      store.setViewport(scopeKey, { scrollTop: 1300, revealSelection: null });
    }
    store.removeThread(THREAD_REF);

    const state = useDiffPanelStore.getState();
    expect(state.byThreadKey).toEqual({});
    expect(state.branchBaseRefByThreadKey).toEqual({});
    expect(Object.keys(state.collapsedFileKeysByScopeKey)).toEqual(retainedScopes);
    expect(Object.keys(state.viewportByScopeKey)).toEqual(retainedScopes);
  });

  it("removes one environment's selections, collapsed files, and viewport captures", () => {
    const retained = scopeThreadRef(EnvironmentId.make("environment-10"), THREAD_REF.threadId);
    const store = useDiffPanelStore.getState();
    for (const ref of [THREAD_REF, retained]) {
      store.selectBranchBaseRef(ref, "origin/main");
      const scopeKey = `${ref.environmentId}:${ref.threadId}:unstaged`;
      store.setCollapsedFileKeys(scopeKey, new Set(["old.ts"]));
      store.setViewport(scopeKey, { scrollTop: 1300, revealSelection: null });
    }
    store.removeEnvironment(THREAD_REF.environmentId);

    const state = useDiffPanelStore.getState();
    expect(Object.keys(state.byThreadKey)).toEqual(["environment-10:thread-1"]);
    expect(Object.keys(state.branchBaseRefByThreadKey)).toEqual(["environment-10:thread-1"]);
    expect(Object.keys(state.collapsedFileKeysByScopeKey)).toEqual([
      "environment-10:thread-1:unstaged",
    ]);
    expect(Object.keys(state.viewportByScopeKey)).toEqual(["environment-10:thread-1:unstaged"]);
  });

  it("does not publish a change when removing a thread with no saved state", () => {
    const before = useDiffPanelStore.getState();
    before.removeThread(THREAD_REF);
    expect(useDiffPanelStore.getState()).toBe(before);
  });
});
