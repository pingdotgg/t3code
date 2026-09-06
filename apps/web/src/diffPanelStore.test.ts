import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  getCheckpointDiffRange,
  THREAD_START_DIFF_BASELINE,
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
} from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
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
  it.each([TurnId.make("turn-1"), THREAD_START_DIFF_BASELINE] as const)(
    "keeps %s pinned while latest advances and a fixed endpoint stays put",
    (baseline) => {
      const first = TurnId.make("turn-1");
      const second = TurnId.make("turn-2");
      const third = TurnId.make("turn-3");
      const store = useDiffPanelStore.getState();
      store.pinBaseline(THREAD_REF, baseline, second);
      store.reconcileTurnSelection(THREAD_REF, [third, second, first]);
      expect(
        selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
      ).toMatchObject({ turnId: third, baselineTurnId: baseline, followLatest: true });
      store.selectTurn(THREAD_REF, second, undefined, { baselineTurnId: baseline });
      store.reconcileTurnSelection(THREAD_REF, [third, second, first]);
      expect(
        selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
      ).toMatchObject({ turnId: second, baselineTurnId: baseline });
      store.selectLatestTurn(THREAD_REF, third);
      expect(
        selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
      ).toMatchObject({ turnId: third, baselineTurnId: baseline, followLatest: true });
      store.pinBaseline(THREAD_REF, null, third);
      expect(
        selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
      ).not.toHaveProperty("baselineTurnId");
    },
  );

  it("drops a removed baseline and falls back when every checkpoint is removed", () => {
    const baseline = TurnId.make("turn-1");
    const latest = TurnId.make("turn-2");
    const store = useDiffPanelStore.getState();
    store.pinBaseline(THREAD_REF, baseline, latest);
    store.reconcileTurnSelection(THREAD_REF, [latest]);
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ turnId: latest, baselineTurnId: undefined });
    store.pinBaseline(THREAD_REF, THREAD_START_DIFF_BASELINE, latest);
    store.reconcileTurnSelection(THREAD_REF, []);
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("opens a timeline turn on its own and isolates pins by environment", () => {
    const turn = TurnId.make("turn-1");
    const store = useDiffPanelStore.getState();
    store.pinBaseline(THREAD_REF, turn, turn);
    const other = scopeThreadRef(EnvironmentId.make("environment-2"), THREAD_REF.threadId);
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, other)).toEqual(
      { kind: "branch", baseRef: null },
    );
    store.selectTurn(THREAD_REF, turn);
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).not.toHaveProperty("baselineTurnId");
  });

  it("preserves the existing unpinned latest-turn selection behavior", () => {
    const first = TurnId.make("turn-1");
    const second = TurnId.make("turn-2");
    const store = useDiffPanelStore.getState();
    store.selectLatestTurn(THREAD_REF, first);
    store.reconcileTurnSelection(THREAD_REF, [second, first]);
    store.reconcileTurnSelection(THREAD_REF, []);
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ kind: "turn", turnId: first });
  });
});

describe("getCheckpointDiffRange", () => {
  it("compares a single turn to its preceding snapshot by default", () => {
    expect(getCheckpointDiffRange(1)).toEqual({ fromTurnCount: 0, toTurnCount: 1 });
    expect(getCheckpointDiffRange(5)).toEqual({ fromTurnCount: 4, toTurnCount: 5 });
  });
  it("excludes the pinned turn's changes and follows the supplied endpoint", () => {
    expect(getCheckpointDiffRange(5, 2)).toEqual({ fromTurnCount: 2, toTurnCount: 5 });
    expect(getCheckpointDiffRange(6, 2)).toEqual({ fromTurnCount: 2, toTurnCount: 6 });
    expect(getCheckpointDiffRange(2, 2)).toEqual({ fromTurnCount: 2, toTurnCount: 2 });
  });
  it("includes turn one when pinned to the initial snapshot", () => {
    expect(getCheckpointDiffRange(1, 0)).toEqual({ fromTurnCount: 0, toTurnCount: 1 });
    expect(getCheckpointDiffRange(6, 0)).toEqual({ fromTurnCount: 0, toTurnCount: 6 });
  });
  it("does not request an unavailable or reversed range", () => {
    expect(getCheckpointDiffRange(null, 2)).toBeNull();
    expect(getCheckpointDiffRange(1, 2)).toBeNull();
  });
});
