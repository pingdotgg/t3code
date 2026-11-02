import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  resolveToolCallDiffTarget,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "./diffPanelStore";

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
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
});
