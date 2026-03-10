import { describe, expect, it } from "vitest";

import {
  buildThreadGroupCollapsibleKey,
  buildThreadGroupChildrenClassName,
  buildThreadGroupDragCursorClassName,
  buildProjectGroupCollapseKey,
  buildProjectChildrenClassName,
  buildThreadGroupDropIndicatorClassName,
  buildThreadGroupChevronClassName,
  buildThreadGroupComposeButtonClassName,
  buildThreadGroupHeaderClassName,
  buildThreadRowClassName,
  buildSidebarInteractionClassName,
  expandCollapsedThreadGroupIds,
  hasCrossedThreadGroupDragThreshold,
  isProjectGroupOpen,
  resolveThreadGroupDropEffect,
  shouldIgnoreSidebarDragPointerDown,
  shouldSnapThreadGroupDropToEnd,
  isValidThreadGroupDropTarget,
  setProjectGroupCollapsed,
  shouldRenderProjectComposeButton,
} from "./sidebarGroupInteractions";

describe("sidebarGroupInteractions", () => {
  it("removes the project-level compose button", () => {
    expect(shouldRenderProjectComposeButton()).toBe(false);
  });

  it("keeps draggable group rows non-selectable and suppresses hover while dragging", () => {
    const activeDragClassName = buildThreadGroupHeaderClassName({
      canDragGroup: true,
      isDraggedGroup: true,
      isAnyGroupDragged: true,
    });

    expect(activeDragClassName).toContain("select-none");
    expect(activeDragClassName).toContain("bg-accent/50");
    expect(activeDragClassName).not.toContain("hover:bg-accent/40");
    expect(activeDragClassName).toContain("cursor-grabbing");
  });

  it("suppresses thread-row hover highlighting while any group drag is active", () => {
    expect(
      buildThreadRowClassName({
        isActive: false,
        isAnyGroupDragged: true,
      }),
    ).toContain("pointer-events-none");
    expect(
      buildThreadGroupComposeButtonClassName({
        isAnyGroupDragged: true,
      }),
    ).toContain("pointer-events-none");
  });

  it("keeps draggable rows pointer-like before drag starts", () => {
    expect(
      buildThreadGroupHeaderClassName({
        canDragGroup: true,
        isDraggedGroup: false,
        isAnyGroupDragged: false,
      }),
    ).toContain("cursor-pointer");
  });

  it("disables child hit targets while a group drag is active", () => {
    expect(buildThreadGroupChildrenClassName({ isOpen: true, isAnyGroupDragged: true })).toContain(
      "pointer-events-none",
    );
    expect(
      buildThreadGroupChildrenClassName({ isOpen: true, isAnyGroupDragged: false }),
    ).toContain("grid-rows-[1fr]");
    expect(
      buildThreadGroupChildrenClassName({ isOpen: false, isAnyGroupDragged: false }),
    ).toContain("grid-rows-[0fr]");
  });

  it("keeps project bodies mounted and driven by explicit project open state", () => {
    expect(
      buildProjectChildrenClassName({ isOpen: true, isAnyProjectDragged: false }),
    ).toContain("grid-rows-[1fr]");
    expect(
      buildProjectChildrenClassName({ isOpen: false, isAnyProjectDragged: false }),
    ).toContain("grid-rows-[0fr]");
    expect(
      buildProjectChildrenClassName({ isOpen: true, isAnyProjectDragged: true }),
    ).toContain("pointer-events-none");
  });

  it("shows a leading chevron that rotates with the group open state", () => {
    expect(buildThreadGroupChevronClassName({ isOpen: false })).not.toContain("rotate-90");
    expect(buildThreadGroupChevronClassName({ isOpen: true })).toContain("rotate-90");
  });

  it("disables text selection across the sidebar only while a group drag is active", () => {
    expect(buildSidebarInteractionClassName({ isAnyGroupDragged: true })).toContain("select-none");
    expect(buildSidebarInteractionClassName({ isAnyGroupDragged: false })).toBe("");
  });

  it("expands a target group without mutating the existing collapsed set", () => {
    const collapsed = new Set(["main", "worktree:/tmp/project/.t3/worktrees/feature-a"]);
    const next = expandCollapsedThreadGroupIds(collapsed, "worktree:/tmp/project/.t3/worktrees/feature-a");

    expect(collapsed.has("worktree:/tmp/project/.t3/worktrees/feature-a")).toBe(true);
    expect(next.has("worktree:/tmp/project/.t3/worktrees/feature-a")).toBe(false);
    expect(next.has("main")).toBe(true);
  });

  it("scopes collapse state by project and group id", () => {
    expect(buildProjectGroupCollapseKey("project-a", "main")).not.toBe(
      buildProjectGroupCollapseKey("project-b", "main"),
    );
  });

  it("sets project group collapse state explicitly instead of toggling blindly", () => {
    const collapseKey = buildProjectGroupCollapseKey("project-a", "main");
    const collapsed = setProjectGroupCollapsed(new Set<string>(), collapseKey, false);
    const expanded = setProjectGroupCollapsed(collapsed, collapseKey, true);

    expect(collapsed.has(collapseKey)).toBe(true);
    expect(expanded.has(collapseKey)).toBe(false);
  });

  it("derives group visibility from the scoped project collapse key", () => {
    const collapsed = new Set([
      buildProjectGroupCollapseKey("project-a", "worktree:a"),
      buildProjectGroupCollapseKey("project-b", "main"),
    ]);

    expect(isProjectGroupOpen(collapsed, "project-a", "worktree:a")).toBe(false);
    expect(isProjectGroupOpen(collapsed, "project-b", "worktree:a")).toBe(true);
    expect(isProjectGroupOpen(collapsed, "project-a", "main")).toBe(true);
  });

  it("shows a visible drop indicator only for the active drop target", () => {
    expect(buildThreadGroupDropIndicatorClassName({ isActiveDropTarget: true })).toContain(
      "bg-primary",
    );
    expect(buildThreadGroupDropIndicatorClassName({ isActiveDropTarget: false })).toContain(
      "opacity-0",
    );
  });

  it("invalidates self-drop targets including dropping to end when already last", () => {
    expect(
      isValidThreadGroupDropTarget({
        draggedGroupId: "worktree:a",
        targetGroupId: "worktree:a",
        lastGroupId: "worktree:b",
      }),
    ).toBe(false);
    expect(
      isValidThreadGroupDropTarget({
        draggedGroupId: "worktree:b",
        targetGroupId: null,
        lastGroupId: "worktree:b",
      }),
    ).toBe(false);
    expect(
      isValidThreadGroupDropTarget({
        draggedGroupId: "worktree:a",
        targetGroupId: "worktree:b",
        lastGroupId: "worktree:b",
      }),
    ).toBe(true);
  });

  it("uses the same move-vs-none decision for drag feedback and drop handling", () => {
    expect(
      resolveThreadGroupDropEffect({
        draggedProjectId: "project-a",
        targetProjectId: "project-a",
        draggedGroupId: "worktree:a",
        targetGroupId: "worktree:b",
        lastGroupId: "worktree:b",
      }),
    ).toBe("move");

    expect(
      resolveThreadGroupDropEffect({
        draggedProjectId: "project-a",
        targetProjectId: "project-b",
        draggedGroupId: "worktree:a",
        targetGroupId: "worktree:b",
        lastGroupId: "worktree:b",
      }),
    ).toBe("none");

    expect(
      resolveThreadGroupDropEffect({
        draggedProjectId: "project-a",
        targetProjectId: "project-a",
        draggedGroupId: "worktree:b",
        targetGroupId: null,
        lastGroupId: "worktree:b",
      }),
    ).toBe("none");
  });

  it("keeps end-of-list dropping active slightly below the visible project list", () => {
    expect(
      shouldSnapThreadGroupDropToEnd({
        pointerX: 120,
        pointerY: 248,
        left: 20,
        right: 220,
        bottom: 200,
        snapStartY: 184,
        thresholdPx: 64,
      }),
    ).toBe(true);

    expect(
      shouldSnapThreadGroupDropToEnd({
        pointerX: 120,
        pointerY: 300,
        left: 20,
        right: 220,
        bottom: 200,
        snapStartY: 184,
        thresholdPx: 64,
      }),
    ).toBe(false);

    expect(
      shouldSnapThreadGroupDropToEnd({
        pointerX: 10,
        pointerY: 220,
        left: 20,
        right: 220,
        bottom: 200,
        snapStartY: 184,
        thresholdPx: 64,
      }),
    ).toBe(false);

    expect(
      shouldSnapThreadGroupDropToEnd({
        pointerX: 120,
        pointerY: 120,
        left: 20,
        right: 220,
        bottom: 200,
        snapStartY: 184,
        thresholdPx: 64,
      }),
    ).toBe(false);
  });

  it("uses a position-scoped collapsible key so reordered open groups remount cleanly", () => {
    expect(
      buildThreadGroupCollapsibleKey("project-a", "worktree:a", [
        "main",
        "worktree:a",
        "worktree:b",
      ]),
    ).not.toBe(
      buildThreadGroupCollapsibleKey("project-a", "worktree:a", [
        "main",
        "worktree:b",
        "worktree:a",
      ]),
    );
  });

  it("forces a consistent grabbing cursor while dragging", () => {
    expect(buildThreadGroupDragCursorClassName({ isDragging: true })).toContain("cursor-grabbing");
    expect(buildThreadGroupDragCursorClassName({ isDragging: false })).toBe("");
  });

  it("activates dragging only after the pointer crosses the drag threshold", () => {
    expect(
      hasCrossedThreadGroupDragThreshold({
        startX: 100,
        startY: 100,
        currentX: 103,
        currentY: 104,
        thresholdPx: 4,
      }),
    ).toBe(false);

    expect(
      hasCrossedThreadGroupDragThreshold({
        startX: 100,
        startY: 100,
        currentX: 105,
        currentY: 100,
        thresholdPx: 4,
      }),
    ).toBe(true);

    expect(
      hasCrossedThreadGroupDragThreshold({
        startX: 100,
        startY: 100,
        currentX: 100,
        currentY: 106,
        thresholdPx: 4,
      }),
    ).toBe(true);
  });

  it("allows a draggable button surface to start drag while still ignoring nested interactive children", () => {
    const currentTarget = {
      closest: () => currentTarget,
    } as unknown as EventTarget;
    const nestedIconButton = {
      closest: () => currentTarget,
    } as unknown as EventTarget;
    const nestedInnerTarget = {
      closest: () => nestedIconButton,
    } as unknown as EventTarget;

    expect(
      shouldIgnoreSidebarDragPointerDown({
        currentTarget,
        target: currentTarget,
      }),
    ).toBe(false);

    expect(
      shouldIgnoreSidebarDragPointerDown({
        currentTarget,
        target: nestedInnerTarget,
      }),
    ).toBe(true);
  });
});
