import { describe, expect, it } from "vitest";

import {
  THREAD_CONTEXT_DRAG_ACTIVATION_DISTANCE,
  isThreadContextDragOutsideList,
  resolvePinnedDragEndShouldReorder,
  resolveThreadContextDragRefs,
  shouldArmThreadContextDrag,
  shouldIgnoreThreadContextDragStart,
} from "./Sidebar.logic";

describe("sidebar thread-context drag gating", () => {
  it("arms every real thread row, pinned or not, but never drafts or virtual-agent runs", () => {
    // Row eligibility is production-gated: SidebarDraftRow never attaches the
    // gesture (structural) and virtual-agent run rows refuse to arm (their
    // ref points at the parent while the label names the child run).
    expect(shouldArmThreadContextDrag({ isDraft: false, isVirtualAgentRun: false })).toBe(true);
    expect(shouldArmThreadContextDrag({ isDraft: true, isVirtualAgentRun: false })).toBe(false);
    expect(shouldArmThreadContextDrag({ isDraft: false, isVirtualAgentRun: true })).toBe(false);
    expect(shouldArmThreadContextDrag({ isDraft: true, isVirtualAgentRun: true })).toBe(false);
  });

  it("ignores presses on drafts and action controls to preserve clicks", () => {
    // Draft discard button, overflow menu trigger, expand chevron, port
    // button, rename input, and links all opt out of the drag gesture.
    for (const target of [
      "button",
      "input",
      "a",
      "textarea",
      "select",
      "[data-thread-selection-safe]",
      "[contenteditable]",
    ]) {
      expect(
        shouldIgnoreThreadContextDragStart({
          button: 0,
          isPrimary: true,
          closest: (s: string) => (s.includes(target) ? {} : null),
        }),
        target,
      ).toBe(true);
    }

    // A plain press on the row title starts the gesture once it moves.
    expect(
      shouldIgnoreThreadContextDragStart({
        button: 0,
        isPrimary: true,
        closest: () => null,
      }),
    ).toBe(false);

    // Non-primary pointers, right/middle clicks, and the activation distance
    // keep plain clicks and text selection working.
    expect(
      shouldIgnoreThreadContextDragStart({ button: 2, isPrimary: true, closest: () => null }),
    ).toBe(true);
    expect(
      shouldIgnoreThreadContextDragStart({ button: 0, isPrimary: false, closest: () => null }),
    ).toBe(true);
    expect(THREAD_CONTEXT_DRAG_ACTIVATION_DISTANCE).toBeGreaterThan(0);
  });

  it("scopes multi-selection identity to the selection when supported", () => {
    const parse = (key: string) => (key.includes(":") ? key : null);
    // Picking up a selected row drags the whole selection.
    expect(
      resolveThreadContextDragRefs({
        activeKey: "env:thread-2",
        selectedKeys: ["env:thread-1", "env:thread-2", "env:thread-3"],
        parseScopedKey: parse,
      }),
    ).toEqual(["env:thread-1", "env:thread-2", "env:thread-3"]);
    // Picking up an unselected row drags only that row.
    expect(
      resolveThreadContextDragRefs({
        activeKey: "env:thread-9",
        selectedKeys: ["env:thread-1", "env:thread-2"],
        parseScopedKey: parse,
      }),
    ).toEqual(["env:thread-9"]);
    // Unparseable keys never leak into the drop payload.
    expect(
      resolveThreadContextDragRefs({
        activeKey: "broken",
        selectedKeys: ["broken", "also-broken"],
        parseScopedKey: parse,
      }),
    ).toEqual([]);
  });

  it("treats horizontal list exit as the context gesture, vertical moves as reorder", () => {
    const bounds = { left: 0, right: 260 };
    expect(isThreadContextDragOutsideList({ x: 130 }, bounds)).toBe(false);
    expect(isThreadContextDragOutsideList({ x: 400 }, bounds)).toBe(true);
    expect(isThreadContextDragOutsideList({ x: -20 }, bounds)).toBe(true);
    // Returning to the sidebar clears the ghost so the reorder preview resumes.
    expect(isThreadContextDragOutsideList({ x: 130 }, bounds)).toBe(false);
  });

  it("never reorders on a context drop, even inside nested project contexts", () => {
    // Dropping on a composer target or on empty space must not move pins,
    // including when nested per-project DndContexts are mounted.
    expect(
      resolvePinnedDragEndShouldReorder({ wasContextDrag: true, activeId: "a", overId: "b" }),
    ).toBe(false);
    expect(
      resolvePinnedDragEndShouldReorder({ wasContextDrag: true, activeId: "a", overId: null }),
    ).toBe(false);
    // Ordinary pinned reordering still works when no context drag happened.
    expect(
      resolvePinnedDragEndShouldReorder({ wasContextDrag: false, activeId: "a", overId: "b" }),
    ).toBe(true);
    expect(
      resolvePinnedDragEndShouldReorder({ wasContextDrag: false, activeId: "a", overId: "a" }),
    ).toBe(false);
    expect(
      resolvePinnedDragEndShouldReorder({ wasContextDrag: false, activeId: "a", overId: null }),
    ).toBe(false);
  });
});
