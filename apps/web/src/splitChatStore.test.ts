import { describe, expect, it, beforeEach } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useSplitChatStore, MAX_SPLIT_CHATS } from "./splitChatStore";
import type { ThreadRouteTarget } from "./threadRoutes";

describe("splitChatStore", () => {
  const thread2: ThreadRouteTarget = {
    kind: "server",
    threadRef: scopeThreadRef("env-1" as EnvironmentId, "thread-2" as ThreadId),
  };
  const thread3: ThreadRouteTarget = {
    kind: "server",
    threadRef: scopeThreadRef("env-1" as EnvironmentId, "thread-3" as ThreadId),
  };
  const thread4: ThreadRouteTarget = {
    kind: "server",
    threadRef: scopeThreadRef("env-1" as EnvironmentId, "thread-4" as ThreadId),
  };
  const thread5: ThreadRouteTarget = {
    kind: "server",
    threadRef: scopeThreadRef("env-1" as EnvironmentId, "thread-5" as ThreadId),
  };

  beforeEach(() => {
    useSplitChatStore.setState(useSplitChatStore.getInitialState(), true);
  });

  it("starts with empty secondary panes and default ratios", () => {
    const state = useSplitChatStore.getState();
    expect(state.secondaryPanes).toHaveLength(0);
    expect(state.activePaneIndex).toBe(0);
    expect(state.horizontalRatio).toBe(0.5);
    expect(state.verticalRatio).toBe(0.5);
    expect(state.topRowRatio).toBe(0.5);
  });

  it("opens a secondary pane to the side and sets active index", () => {
    const success = useSplitChatStore.getState().openToSide(thread2);
    expect(success).toBe(true);

    const state = useSplitChatStore.getState();
    expect(state.secondaryPanes).toHaveLength(1);
    expect(state.secondaryPanes[0]).toEqual(thread2);
    expect(state.activePaneIndex).toBe(1);
  });

  it("focuses an existing pane instead of duplicating it", () => {
    useSplitChatStore.getState().openToSide(thread2);
    useSplitChatStore.getState().openToSide(thread3);
    expect(useSplitChatStore.getState().secondaryPanes).toHaveLength(2);

    const success = useSplitChatStore.getState().openToSide(thread2);
    expect(success).toBe(true);
    expect(useSplitChatStore.getState().secondaryPanes).toHaveLength(2);
    expect(useSplitChatStore.getState().activePaneIndex).toBe(1);

    expect(useSplitChatStore.getState().openToSide(thread3, thread3)).toBe(true);
    expect(useSplitChatStore.getState().secondaryPanes).toHaveLength(2);
    expect(useSplitChatStore.getState().activePaneIndex).toBe(0);
  });

  it("enforces the maximum limit of 4 chats total (3 secondary)", () => {
    expect(useSplitChatStore.getState().openToSide(thread2)).toBe(true);
    expect(useSplitChatStore.getState().openToSide(thread3)).toBe(true);
    expect(useSplitChatStore.getState().openToSide(thread4)).toBe(true);
    expect(useSplitChatStore.getState().secondaryPanes).toHaveLength(MAX_SPLIT_CHATS - 1);

    expect(useSplitChatStore.getState().openToSide(thread5)).toBe(false);
    expect(useSplitChatStore.getState().secondaryPanes).toHaveLength(3);
  });

  it("resizes each row and column independently", () => {
    const store = useSplitChatStore.getState();
    store.setTopRowRatio(0.3);
    store.setBottomRowRatio(0.7);
    store.setVerticalRatio(0.4);
    store.setRightColumnRatio(0.65);
    expect(useSplitChatStore.getState()).toMatchObject({
      topRowRatio: 0.3,
      bottomRowRatio: 0.7,
      verticalRatio: 0.4,
      rightColumnRatio: 0.65,
    });
  });

  it("clamps resize ratios between 0.15 and 0.85", () => {
    useSplitChatStore.getState().setHorizontalRatio(0.05);
    expect(useSplitChatStore.getState().horizontalRatio).toBe(0.15);

    useSplitChatStore.getState().setHorizontalRatio(0.95);
    expect(useSplitChatStore.getState().horizontalRatio).toBe(0.85);

    useSplitChatStore.getState().setHorizontalRatio(0.6);
    expect(useSplitChatStore.getState().horizontalRatio).toBe(0.6);
  });
  it("restores resize preferences without reopening panes from an earlier launch", () => {
    const merge = useSplitChatStore.persist.getOptions().merge!;
    const restored = merge(
      {
        secondaryPanes: [thread2, thread3],
        activePaneIndex: 2,
        horizontalRatio: 0.6,
        verticalRatio: Number.NaN,
        topRowRatio: 2,
        resizeLayout: "columns",
      },
      useSplitChatStore.getInitialState(),
    );
    expect(restored.secondaryPanes).toEqual([]);
    expect(restored.activePaneIndex).toBe(0);
    expect(restored.horizontalRatio).toBe(0.6);
    expect(restored.verticalRatio).toBe(0.5);
    expect(restored.topRowRatio).toBe(0.85);
    expect(restored.resizeLayout).toBe("columns");
  });
});
