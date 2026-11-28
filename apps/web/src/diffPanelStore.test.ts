import { EnvironmentId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  chooseThreadGitRepository,
  resolveToolCallDiffTarget,
  selectThreadBranchBaseRef,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "./diffPanelStore";

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      gitRepositoryPathByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("drops a commit and base ref of the repository a thread's Git controls leave", () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
    const key = scopedThreadKey(ref);
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(ref, "origin/main");
    store.selectCommit(ref, "abc123");
    chooseThreadGitRepository(ref, "/work/web");
    expect(useDiffPanelStore.getState().gitRepositoryPathByThreadKey[key]).toBe("/work/web");
    expect(useDiffPanelStore.getState().byThreadKey[key]).toEqual({
      kind: "branch",
      baseRef: null,
    });

    // Uncommitted changes and a turn read whichever repository is picked, so they stay.
    store.selectBranchBaseRef(ref, "origin/main");
    store.selectGitScope(ref, "unstaged");
    chooseThreadGitRepository(ref, null);
    expect(useDiffPanelStore.getState().byThreadKey[key]).toEqual({ kind: "unstaged" });
    expect(selectThreadBranchBaseRef(useDiffPanelStore.getState(), ref)).toBeNull();
    store.selectTurn(ref, RunId.make("run"));
    chooseThreadGitRepository(ref, "/work/web");
    expect(useDiffPanelStore.getState().byThreadKey[key]?.kind).toBe("turn");
  });

  it("restores a nested repository with the base ref chosen in it after a reload", async () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
    chooseThreadGitRepository(ref, "/work/web");
    useDiffPanelStore.getState().selectBranchBaseRef(ref, "origin/release");

    const { storage, name } = useDiffPanelStore.persist.getOptions();
    const persisted = await storage!.getItem(name!);
    expect(persisted).not.toBeNull();
    useDiffPanelStore.setState(useDiffPanelStore.getInitialState());
    await storage!.setItem(name!, persisted!);
    await useDiffPanelStore.persist.rehydrate();

    // The base ref still applies to the repository it was chosen in, not the thread's folder.
    const state = useDiffPanelStore.getState();
    expect(state.gitRepositoryPathByThreadKey[scopedThreadKey(ref)]).toBe("/work/web");
    expect(selectThreadBranchBaseRef(state, ref)).toBe("origin/release");
  });

  it("keeps a tool call selection independent of checkpoints and allows returning to Git changes", () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
    const target = {
      threadId: ThreadId.make("child"),
      itemId: TurnItemId.make("edit"),
      revision: "1",
    };
    const store = useDiffPanelStore.getState();
    store.selectToolCall(ref, target);
    store.reconcileTurnSelection(ref, []);
    expect(useDiffPanelStore.getState().byThreadKey[scopedThreadKey(ref)]).toEqual({
      kind: "tool-call",
      ...target,
    });
    store.selectGitScope(ref, "branch");
    expect(useDiffPanelStore.getState().byThreadKey[scopedThreadKey(ref)]).toEqual({
      kind: "branch",
      baseRef: null,
    });
  });

  it("keeps Unicode whitespace at the edges of a picked base branch", () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(ref, "feat\u00a0");
    expect(useDiffPanelStore.getState().byThreadKey[scopedThreadKey(ref)]).toEqual({
      kind: "branch",
      baseRef: "feat\u00a0",
    });
    store.selectBranchBaseRef(ref, " \t");
    expect(useDiffPanelStore.getState().byThreadKey[scopedThreadKey(ref)]).toEqual({
      kind: "branch",
      baseRef: null,
    });
  });

  it("refreshes a live tool-call target when its source item completes", () => {
    const target = {
      threadId: ThreadId.make("child"),
      itemId: TurnItemId.make("edit"),
      revision: "live",
    };
    const now = DateTime.makeUnsafe("2026-10-28T00:00:00Z");
    const row = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: target.threadId,
      sourceItemId: target.itemId,
      item: {
        id: target.itemId,
        threadId: target.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running" as const,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "file_change" as const,
        fileName: "a.ts",
      },
    };
    expect(resolveToolCallDiffTarget(target, [row])).toBe(target);
    const completed = {
      ...row,
      item: { ...row.item, status: "completed" as const, completedAt: now },
    };
    expect(resolveToolCallDiffTarget(target, [completed])).toEqual({
      ...target,
      revision: DateTime.formatIso(now),
    });
    expect(
      resolveToolCallDiffTarget(target, [{ ...completed, sourceThreadId: ThreadId.make("other") }]),
    ).toBe(target);
    expect(resolveToolCallDiffTarget(target, [])).toBe(target);
  });

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });

  it("keeps the repository filter across turns and drops it for a requested file", () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
    const selection = () => useDiffPanelStore.getState().byThreadKey[scopedThreadKey(ref)];
    const store = useDiffPanelStore.getState();
    store.selectTurnRepository(ref, RunId.make("run-1"), "/work/api");
    store.selectTurn(ref, RunId.make("run-2"));
    expect(selection()).toMatchObject({ turnId: "run-2", repository: "/work/api" });
    store.selectTurn(ref, RunId.make("run-2"), "web/src/index.ts");
    expect(selection()).toEqual({
      kind: "turn",
      turnId: "run-2",
      filePath: "web/src/index.ts",
      revealRequestId: 2,
    });
    store.selectTurnRepository(ref, RunId.make("run-2"), "/work/api");
    store.selectTurnRepository(ref, RunId.make("run-2"), null);
    expect(selection()).not.toHaveProperty("repository");
  });
});
