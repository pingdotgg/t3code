import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  countLeafNodes,
  findLeafNodeByTarget,
  getFocusedLeaf,
  getLeafTargetsInRenderOrder,
} from "./chatSplitLayout";
import { useChatSplitLayoutStore } from "./chatSplitLayoutStore";

const initialState = useChatSplitLayoutStore.getState();

afterEach(() => {
  useChatSplitLayoutStore.setState(initialState, true);
});

function getActiveLayout() {
  const layout = useChatSplitLayoutStore.getState().layout;
  expect(layout).not.toBeNull();
  return layout!;
}

describe("chatSplitLayoutStore", () => {
  it("preserves same-environment split panes when route targets change", () => {
    const envA = EnvironmentId.make("env-a");
    const envB = EnvironmentId.make("env-b");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envB,
        threadId: ThreadId.make("thread-b"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    expect(countLeafNodes(getActiveLayout())).toBe(2);

    useChatSplitLayoutStore.getState().syncRouteTarget(targetB);
    expect(countLeafNodes(getActiveLayout())).toBe(1);

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");
    expect(countLeafNodes(getActiveLayout())).toBe(2);

    useChatSplitLayoutStore.getState().syncRouteTarget({
      kind: "server",
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-c"),
      },
    });
    const layout = getActiveLayout();
    expect(countLeafNodes(layout)).toBe(2);
    expect(findLeafNodeByTarget(layout, targetA)).not.toBeNull();
  });

  it("opens selected targets as the only active split workspace", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetC = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-c"),
      },
    };
    const targetD = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-d"),
      },
    };

    const focusedTarget = useChatSplitLayoutStore
      .getState()
      .openWorkspaceFromTargets([targetC, targetD], "column");
    expect(focusedTarget).toEqual(targetD);

    let layout = getActiveLayout();
    expect(findLeafNodeByTarget(layout, targetC)).not.toBeNull();
    expect(findLeafNodeByTarget(layout, targetD)).not.toBeNull();

    useChatSplitLayoutStore.getState().syncRouteTarget({
      kind: "server",
      threadRef: {
        environmentId: EnvironmentId.make("env-b"),
        threadId: ThreadId.make("thread-a"),
      },
    });
    layout = getActiveLayout();
    expect(countLeafNodes(layout)).toBe(1);
    expect(findLeafNodeByTarget(layout, targetA)).toBeNull();
    expect(findLeafNodeByTarget(layout, targetC)).toBeNull();
    expect(findLeafNodeByTarget(layout, targetD)).toBeNull();
  });

  it("replaces the active split workspace when selected targets overlap it", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };
    const targetC = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-c"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    const activeLayout = getActiveLayout();
    useChatSplitLayoutStore.getState().replaceLeafTarget(activeLayout.focusedLeafId, targetB);

    useChatSplitLayoutStore.getState().openWorkspaceFromTargets([targetB, targetC], "row");

    const layout = getActiveLayout();
    expect(findLeafNodeByTarget(layout, targetA)).toBeNull();
    expect(findLeafNodeByTarget(layout, targetB)).not.toBeNull();
    expect(findLeafNodeByTarget(layout, targetC)).not.toBeNull();
  });

  it("replaces the focused pane when routing to a thread outside the current split", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };
    const targetC = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-c"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    const activeLayout = getActiveLayout();
    useChatSplitLayoutStore.getState().replaceLeafTarget(activeLayout.focusedLeafId, targetB);

    useChatSplitLayoutStore.getState().syncRouteTarget(targetC);

    const layout = getActiveLayout();
    expect(countLeafNodes(layout)).toBe(2);
    expect(findLeafNodeByTarget(layout, targetA)).not.toBeNull();
    expect(findLeafNodeByTarget(layout, targetB)).toBeNull();
    expect(findLeafNodeByTarget(layout, targetC)).not.toBeNull();
  });

  it("maximizes and restores the focused pane without discarding the split", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    const activeLayout = getActiveLayout();
    const targetBLeafId = activeLayout.focusedLeafId;
    useChatSplitLayoutStore.getState().replaceLeafTarget(targetBLeafId, targetB);

    useChatSplitLayoutStore.getState().focusLeaf(targetBLeafId);
    useChatSplitLayoutStore.getState().toggleFocusedLeafMaximized();

    let layout = getActiveLayout();
    expect(countLeafNodes(layout)).toBe(2);
    expect(layout.maximizedLeafId).toBe(targetBLeafId);
    expect(findLeafNodeByTarget(layout, targetA)).not.toBeNull();
    expect(findLeafNodeByTarget(layout, targetB)).not.toBeNull();

    useChatSplitLayoutStore.getState().toggleFocusedLeafMaximized();

    layout = getActiveLayout();
    expect(countLeafNodes(layout)).toBe(2);
    expect(layout.maximizedLeafId).toBeNull();
    expect(findLeafNodeByTarget(layout, targetA)).not.toBeNull();
    expect(findLeafNodeByTarget(layout, targetB)).not.toBeNull();
  });

  it("drops a thread target into a specific leaf placement", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    const leafId = getActiveLayout().focusedLeafId;

    expect(useChatSplitLayoutStore.getState().dropTargetIntoLeaf(leafId, targetB, "left")).toEqual(
      targetB,
    );

    const layout = getActiveLayout();
    expect(getLeafTargetsInRenderOrder(layout).map((leaf) => leaf.target)).toEqual([
      targetB,
      targetA,
    ]);
    expect(getFocusedLeaf(layout)?.target).toEqual(targetB);
  });

  it("fills a blank split leaf when a thread is dropped onto it", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    const layout = getActiveLayout();
    const blankLeafId = layout.focusedLeafId;
    expect(getFocusedLeaf(layout)?.target).toBeNull();

    expect(
      useChatSplitLayoutStore.getState().dropTargetIntoLeaf(blankLeafId, targetB, "right"),
    ).toEqual(targetB);

    const nextLayout = getActiveLayout();
    expect(countLeafNodes(nextLayout)).toBe(2);
    expect(getLeafTargetsInRenderOrder(nextLayout).map((leaf) => leaf.target)).toEqual([
      targetA,
      targetB,
    ]);
  });

  it("route selection fills a focused blank split leaf", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    useChatSplitLayoutStore.getState().syncRouteTarget(targetB);

    const layout = getActiveLayout();
    expect(countLeafNodes(layout)).toBe(2);
    expect(findLeafNodeByTarget(layout, targetA)).not.toBeNull();
    expect(findLeafNodeByTarget(layout, targetB)).not.toBeNull();
  });

  it("preserves sibling panes when splitting a focused pane", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };
    const targetC = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-c"),
      },
    };

    useChatSplitLayoutStore.getState().openWorkspaceFromTargets([targetA, targetB, targetC], "row");

    const targetALeafId = findLeafNodeByTarget(getActiveLayout(), targetA)!.id;
    useChatSplitLayoutStore.getState().focusLeaf(targetALeafId);
    useChatSplitLayoutStore.getState().splitFocusedLeaf("row");

    const layout = getActiveLayout();
    expect(countLeafNodes(layout)).toBe(4);
    expect(getLeafTargetsInRenderOrder(layout).map((leaf) => leaf.target)).toEqual([
      targetA,
      null,
      targetB,
      targetC,
    ]);
  });

  it("focuses an existing split leaf instead of duplicating a dropped thread", () => {
    const envA = EnvironmentId.make("env-a");
    const targetA = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-a"),
      },
    };
    const targetB = {
      kind: "server" as const,
      threadRef: {
        environmentId: envA,
        threadId: ThreadId.make("thread-b"),
      },
    };

    useChatSplitLayoutStore.getState().syncRouteTarget(targetA);
    const leafId = getActiveLayout().focusedLeafId;
    useChatSplitLayoutStore.getState().dropTargetIntoLeaf(leafId, targetB, "right");

    const layout = getActiveLayout();
    const targetALeafId = findLeafNodeByTarget(layout, targetA)!.id;
    useChatSplitLayoutStore.getState().dropTargetIntoLeaf(targetALeafId, targetB, "bottom");

    expect(countLeafNodes(getActiveLayout())).toBe(2);
    expect(getFocusedLeaf(getActiveLayout())?.target).toEqual(targetB);
  });
});
