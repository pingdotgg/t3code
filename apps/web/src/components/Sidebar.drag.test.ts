import { describe, expect, it, vi } from "vite-plus/test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { closestCenter, DndContext, type Modifier, type CollisionDetection } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import {
  collapseDraggedTask,
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  createTaskSidebarSortingStrategy,
  createTaskSidebarDragOffset,
  restrictBelowSidebarLabel,
} from "./Sidebar.drag";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "./Sidebar.logic";
import { EnvironmentId, ProjectId, TaskId, ThreadId } from "@t3tools/contracts";
import { scopeTaskRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as taskSidebar from "./Sidebar.tasks";
import { taskSidebarItemId, type TaskSidebarItem } from "./Sidebar.tasks";

const thread = (key: string, section: SidebarSection): SidebarListItem => ({
  kind: "thread",
  key,
  section,
});
const marker = (marker: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker });
const pinnedHeader = marker("pinned-header");
const divider = marker("pinned-divider");
const settledHeader = marker("settled-header");
const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

function layout(
  items: readonly SidebarListItem[],
  active: string,
  over: string,
  scale = 1,
  cardHeight = 82,
) {
  let top = 100;
  const rects = items.map((item) => {
    const height =
      item.kind === "thread"
        ? (item.section === "pinned" || item.section === "active" ? cardHeight : 36) * scale
        : item.marker === "pinned-header" || item.marker === "pinned-divider"
          ? 0
          : (item.marker.endsWith("placeholder") ? 0 : 32) * scale;
    const rect = { top, height, bottom: top + height, left: 0, right: 260, width: 260 };
    top += height + 1;
    return rect;
  });
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === active);
  return {
    activeIndex,
    overIndex: items.findIndex((item) => sidebarListItemId(item) === over),
    activeNodeRect: rects[activeIndex]!,
    rects,
    index: 0,
  } satisfies Parameters<SortingStrategy>[0];
}

function preview(
  input: Parameters<typeof createSidebarSortingStrategy>[0],
  active: string,
  over: string,
  scale = 1,
) {
  const strategy = createSidebarSortingStrategy(input);
  const args = layout(input.items, active, over, scale);
  return new Map(
    input.items.map((item, index) => [sidebarListItemId(item), strategy({ ...args, index })]),
  );
}

describe("sidebar collision detection", () => {
  function collisionArgs(blockedAboveSource = false) {
    const rows = [thread("source", "active"), thread("blocked", "active")];
    const items = [
      pinnedHeader,
      divider,
      ...(blockedAboveSource ? rows.toReversed() : rows),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const { rects, activeIndex, overIndex } = layout(items, "source", "blocked");
    const collisionRect = rects[overIndex]!;
    return {
      active: {
        id: "source",
        data: { current: {} },
        rect: { current: { initial: rects[activeIndex]!, translated: collisionRect } },
      },
      collisionRect,
      droppableRects: new Map(items.map((item, index) => [sidebarListItemId(item), rects[index]!])),
      droppableContainers: items.map((item, index) => ({
        id: sidebarListItemId(item),
        key: sidebarListItemId(item),
        disabled: false,
        data: { current: {} },
        node: { current: null },
        rect: { current: rects[index]! },
      })),
      pointerCoordinates: null,
    } satisfies Parameters<CollisionDetection>[0];
  }

  it.each([
    [false, sidebarMarkerId("settled-header")],
    [true, sidebarMarkerId("pinned-divider")],
  ] as const)(
    "rejects unsupported Active instead of selecting %s / %s",
    (blockedAboveSource, nearbyTarget) => {
      const args = collisionArgs(blockedAboveSource);
      const detector = createSidebarCollisionDetection((id) => id !== "blocked");
      const filtered = closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (container) => container.id !== "blocked",
        ),
      });
      expect(filtered[0]?.id).toBe(nearbyTarget);
      expect(detector(args).map((collision) => collision.id)).toEqual(["source"]);
    },
  );

  it("selects the nearest supported target", () => {
    const detector = createSidebarCollisionDetection(() => true);
    expect(detector(collisionArgs())[0]?.id).toBe("blocked");
  });

  it.each([
    { sourceSection: "active", pins: 0 },
    { sourceSection: "active", pins: 1 },
    { sourceSection: "pinned", pins: 1 },
    { sourceSection: "settled", pins: 1 },
  ] as const)(
    "switches on crossing the divider row from $sourceSection with $pins pins",
    ({ sourceSection, pins }) => {
      const items = [
        pinnedHeader,
        ...(pins ? [thread("p", "pinned")] : []),
        ...(sourceSection === "pinned" ? [thread("source", "pinned")] : []),
        divider,
        thread("a", "active"),
        ...(sourceSection === "active" ? [thread("source", "active")] : []),
        settledHeader,
        ...(sourceSection === "settled" ? [thread("source", "settled")] : []),
      ];
      const { rects, activeIndex } = layout(items, "source", "a");
      const sourceRect = rects[activeIndex]!;
      let boundaryTop = 300;
      const boundaryNode = {
        querySelector: () => ({
          getBoundingClientRect: () => ({
            top: boundaryTop,
            bottom: boundaryTop + 16,
            left: 0,
            right: 260,
          }),
        }),
      } as unknown as HTMLElement;
      const detector = createSidebarCollisionDetection(() => true, {
        items,
        activationY: sourceSection === "pinned" ? 200 : 600,
      });
      const at = (center: number) => {
        const collisionRect = {
          ...sourceRect,
          top: center - sourceRect.height / 2,
          bottom: center + sourceRect.height / 2,
        };
        const args = {
          ...collisionArgs(),
          active: {
            id: "source",
            data: { current: {} },
            rect: { current: { initial: sourceRect, translated: collisionRect } },
          },
          collisionRect,
          pointerCoordinates: { x: 130, y: center },
          droppableRects: new Map(
            items.map((item, index) => [sidebarListItemId(item), rects[index]!]),
          ),
          droppableContainers: items.map((item, index) => ({
            id: sidebarListItemId(item),
            key: sidebarListItemId(item),
            disabled: false,
            data: { current: {} },
            node: {
              current:
                item === divider
                  ? boundaryNode
                  : item === settledHeader
                    ? ({ getBoundingClientRect: () => ({ top: 600 }) } as unknown as HTMLElement)
                    : null,
            },
            rect: { current: rects[index]! },
          })),
        };
        const over = detector(args)[0];
        return over ? resolveSidebarDropTarget(items, "source", String(over.id))?.section : null;
      };
      expect(at(330)).toBe("active");
      expect(at(317)).toBe("active");
      expect(at(316)).toBe("pinned");
      // The preview moves the divider; a stationary pointer must not undo the drop target.
      boundaryTop = 400;
      expect(at(316)).toBe("pinned");
      expect(at(399)).toBe("pinned");
      expect(at(400)).toBe("active");
      boundaryTop = 300;
      expect(at(400)).toBe("active");
      expect(at(317)).toBe("active");
      expect(at(316)).toBe("pinned");
    },
  );

  it("returns no collision if an unsupported target has no source fallback", () => {
    const args = collisionArgs();
    const detector = createSidebarCollisionDetection(() => false);
    expect(
      detector({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (container) => container.id !== "source",
        ),
      }),
    ).toEqual([]);
  });

  it("validates each hovered target once and always allows returning to the source", () => {
    const args = collisionArgs();
    const isValid = vi.fn((id: string) => id !== "blocked");
    const detector = createSidebarCollisionDetection(isValid);
    expect(detector(args)[0]?.id).toBe("source");
    expect(
      detector({
        ...args,
        collisionRect: {
          ...args.collisionRect,
          top: args.collisionRect.top + 3,
          bottom: args.collisionRect.bottom + 3,
        },
      })[0]?.id,
    ).toBe("source");
    expect(detector({ ...args, collisionRect: args.droppableRects.get("source")! })[0]?.id).toBe(
      "source",
    );
    expect(
      detector({
        ...args,
        collisionRect: args.droppableRects.get(sidebarMarkerId("settled-placeholder"))!,
      })[0]?.id,
    ).toBe(sidebarMarkerId("settled-placeholder"));
    expect(isValid.mock.calls).toEqual([["blocked"], [sidebarMarkerId("settled-placeholder")]]);
  });
});

describe("sidebar drag projection", () => {
  const pinned = [
    pinnedHeader,
    thread("p1", "pinned"),
    thread("p2", "pinned"),
    divider,
    thread("a1", "active"),
    settledHeader,
    thread("s1", "settled"),
  ];

  it.each([
    ["p1", "p2"],
    ["p2", "p1"],
  ])("preserves existing pinned transforms from %s to %s", (active, over) => {
    const strategy = createSidebarSortingStrategy({
      items: pinned,
      settledOrder: [],
      settledExpanded: true,
    });
    const args = layout(pinned, active, over);
    // dnd-kit moves the lifted row by the pointer delta, so only peers matter.
    for (let index = 0; index < pinned.length; index += 1) {
      if (index === args.activeIndex) continue;
      expect(strategy({ ...args, index })).toEqual(verticalListSortingStrategy({ ...args, index }));
    }
  });

  it("keeps the pinned header above the gap when a lower pin moves to the top", () => {
    const result = preview(
      { items: pinned, settledOrder: [], settledExpanded: true },
      "p2",
      sidebarMarkerId("pinned-header"),
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get("p1")).toEqual({ ...stationary, y: 83 });
    expect(result.get(sidebarMarkerId("pinned-divider"))).toEqual(stationary);
    expect(result.get("a1")).toEqual(stationary);
  });

  it.each([
    ["a1", "a2"],
    ["a2", "a1"],
  ])("uses pinned dragging behavior for Active from %s to %s", (active, over) => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: [],
      settledExpanded: true,
    });
    const args = layout(items, active, over);
    for (let index = 0; index < items.length; index += 1) {
      if (index === args.activeIndex) continue;
      expect(strategy({ ...args, index })).toEqual(verticalListSortingStrategy({ ...args, index }));
    }
  });

  it("preserves settled order while opening the zero-height Active target", () => {
    const items = [
      pinnedHeader,
      divider,
      marker("active-placeholder"),
      settledHeader,
      thread("first", "settled"),
      thread("second", "settled"),
    ];
    const result = preview(
      { items, settledOrder: ["first", "second"], settledExpanded: true },
      "second",
      "first",
    );
    expect(result.get(sidebarMarkerId("active-placeholder"))).toEqual(stationary);
    expect(result.get(sidebarMarkerId("settled-header"))).toEqual({ ...stationary, y: 36 });
    expect(result.get("first")).toEqual({ ...stationary, y: 36 });
    expect(result.get("second")).toEqual(stationary);
  });

  it.each([
    [sidebarMarkerId("pinned-divider"), 0, 0],
    ["a1", -83, 0],
    ["a2", -83, -83],
  ] as const)(
    "opens the active pointer slot over %s without adding an empty pinned row",
    (over, a1Offset, a2Offset) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        thread("a1", "active"),
        thread("a2", "active"),
        settledHeader,
        thread("s", "settled"),
      ];
      const result = preview({ items, settledOrder: [], settledExpanded: true }, "p", over);
      expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
      expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(-83);
      expect(result.get("a1")?.y).toBe(a1Offset);
      expect(result.get("a2")?.y).toBe(a2Offset);
      expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(0);
    },
  );

  it("opens label space below each pinned boundary while dragging", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    // Reorder inside active: the header gap shifts every row, the divider
    // gap shifts the active rows and the shelf below by a second label.
    const result = preview(
      { items, settledOrder: [], settledExpanded: true, boundaryLabelHeight: 16 },
      "a2",
      "a1",
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get("p")?.y).toBe(16);
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(16);
    expect(result.get("a2")).toEqual(stationary);
    expect(result.get("a1")?.y).toBe(32 + 83);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(32);
    expect(result.get("s")?.y).toBe(32);
  });

  it.each(["s1", "missing-target"])(
    "keeps label clearance when a settled drag is over %s",
    (over) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        thread("a", "active"),
        settledHeader,
        thread("s1", "settled"),
        thread("s2", "settled"),
      ];
      const result = preview(
        {
          items,
          settledOrder: ["s1", "s2"],
          settledExpanded: true,
          boundaryLabelHeight: 24,
        },
        "s2",
        over,
      );
      expect(result.get("p")?.y).toBe(24);
      expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(24);
      expect(result.get("a")?.y).toBe(48);
      expect(result.get("s1")?.y).toBe(48);
      expect(result.get("s2")).toEqual(stationary);
    },
  );

  it("stacks the labels with their gaps when the pinned section is empty", () => {
    const items = [
      pinnedHeader,
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: true, boundaryLabelHeight: 16 },
      "a2",
      "a1",
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(16);
    expect(result.get("a1")?.y).toBe(32 + 83);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(32);
  });

  it("scales the label space with the measured root scale", () => {
    const items = [pinnedHeader, thread("p", "pinned"), divider, thread("a1", "active")];
    const result = preview(
      { items, settledOrder: [], settledExpanded: true, boundaryLabelHeight: 16 },
      "a1",
      "p",
      2,
    );
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(32 + 165);
  });

  it("keeps the pinned header above the first arriving pin", () => {
    const items = [
      pinnedHeader,
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: true },
      "a2",
      sidebarMarkerId("pinned-header"),
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(83);
    expect(result.get("a1")?.y).toBe(83);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(0);
  });

  it.each([
    ["p", -83, -1],
    ["s", 0, 82],
  ] as const)(
    "replaces the empty Active target when %s enters",
    (active, dividerOffset, settledOffset) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        marker("active-placeholder"),
        settledHeader,
        thread("s", "settled"),
      ];
      const result = preview(
        { items, settledOrder: [], settledExpanded: true },
        active,
        sidebarMarkerId("active-placeholder"),
      );
      expect(result.get(sidebarMarkerId("active-placeholder"))?.scaleY).toBe(0);
      expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(dividerOffset);
      expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(settledOffset);
    },
  );

  it("uses the canonical settled rank and the destination's slim height", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      thread("s1", "settled"),
      thread("s2", "settled"),
    ];
    const result = preview(
      { items, settledOrder: ["s1", "a", "s2"], settledExpanded: true },
      "a",
      "s2",
    );
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(-46);
    expect(result.get("s1")?.y).toBe(-46);
    expect(result.get("s2")?.y).toBe(-9);
  });

  it.each([
    ["a1", 83],
    ["a2", 0],
  ] as const)(
    "reserves a full card at the pointer slot over %s when a slim row enters Active",
    (over, firstOffset) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        thread("a1", "active"),
        thread("a2", "active"),
        settledHeader,
        thread("s", "settled"),
      ];
      const result = preview({ items, settledOrder: [], settledExpanded: true }, "s", over);
      expect(result.get("a1")?.y).toBe(firstOffset);
      expect(result.get("a2")?.y).toBe(83);
      expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(83);
    },
  );

  it("removes the snoozed header when its last row leaves", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      marker("snoozed-header"),
      thread("z", "snoozed"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview({ items, settledOrder: [], settledExpanded: true }, "z", "a");
    expect(result.get(sidebarMarkerId("snoozed-header"))?.scaleY).toBe(0);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(13);
    expect(result.get("s")?.y).toBe(13);
  });

  it("keeps a collapsed settled target without inserting a hidden row", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: false },
      "a2",
      sidebarMarkerId("settled-placeholder"),
    );
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(-83);
    expect(result.get(sidebarMarkerId("settled-placeholder"))).toEqual({ ...stationary, y: -83 });
  });

  it("preserves a collapsed snoozed header while another section changes", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      marker("snoozed-header"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: false },
      "a",
      sidebarMarkerId("settled-placeholder"),
    );
    expect(result.get(sidebarMarkerId("snoozed-header"))).toEqual({ ...stationary, y: -46 });
  });

  it("derives missing card geometry from the measured root scale", () => {
    const items = [
      pinnedHeader,
      divider,
      marker("active-placeholder"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: true },
      "s",
      sidebarMarkerId("pinned-header"),
      0.75,
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(62.5);
    expect(result.get(sidebarMarkerId("active-placeholder"))?.y).toBe(62.5);
  });

  it("updates the projection when the target or measured geometry changes", () => {
    const strategy = createSidebarSortingStrategy({
      items: pinned,
      settledOrder: [],
      settledExpanded: true,
    });
    const args = layout(pinned, "p1", "p1");
    expect(strategy({ ...args, index: 2 })?.y).toBe(0);
    expect(strategy({ ...args, index: 2, overIndex: 4 })?.y).toBe(-83);
    const smaller = layout(pinned, "p1", "a1", 0.75);
    expect(strategy({ ...smaller, index: 2 })?.y).toBe(-62.5);
  });

  it.each(["active", "settled"] as const)(
    "reveals the mounted empty %s target when its last row leaves and hides it on return",
    (section) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        marker("active-placeholder"),
        thread("a", "active"),
        settledHeader,
        marker("settled-placeholder"),
        thread("s", "settled"),
      ];
      const active = section === "active" ? "a" : "s";
      const input = { items, settledOrder: ["s"], settledExpanded: true };
      const placeholderId = sidebarMarkerId(`${section}-placeholder`);
      const resting = preview(input, active, active);
      expect(resting.get(placeholderId)?.scaleY).toBe(0);
      const leaving = preview(input, active, sidebarMarkerId("pinned-header"));
      expect(leaving.get(placeholderId)?.scaleY).toBe(1);
      const returning = preview(input, active, active);
      expect(returning.get(placeholderId)?.scaleY).toBe(0);
    },
  );

  it("uses shelf height for empty target sizing when card height differs from its default", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: [],
      settledExpanded: false,
    });
    const args = layout(items, "a", sidebarMarkerId("settled-placeholder"), 1, 78);
    expect(strategy({ ...args, index: 4 })?.y).toBe(-42);
  });

  it("keeps the route row visible after a settled drop pushes it beyond the page", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    const input = {
      items,
      settledOrder: ["a", "s", "hidden"],
      settledExpanded: true,
      settledVisibleCount: 1,
    };
    const withRoute = preview({ ...input, routeThreadKey: "s" }, "a", "s");
    const withoutRoute = preview(input, "a", "s");
    expect(withRoute.get("s")).toEqual({ ...stationary, y: -9 });
    expect(withoutRoute.get("s")?.scaleY).toBe(0);
  });

  it("reserves the next page row when a visible settled thread leaves", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      thread("s1", "settled"),
      thread("route", "settled"),
    ];
    const result = preview(
      {
        items,
        settledOrder: ["s1", "hidden", "route"],
        settledExpanded: true,
        settledVisibleCount: 1,
        routeThreadKey: "route",
      },
      "s1",
      "a",
    );
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(83);
    expect(result.get("route")?.y).toBe(83);
  });

  it("keeps the dropped route thread visible in a collapsed settled shelf", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const result = preview(
      {
        items,
        settledOrder: ["a", "hidden"],
        settledExpanded: false,
        settledVisibleCount: 1,
        routeThreadKey: "a",
      },
      "a",
      sidebarMarkerId("settled-placeholder"),
    );
    expect(result.get(sidebarMarkerId("settled-placeholder"))?.scaleY).toBe(0);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(-46);
  });

  it("preserves hidden snoozed membership when the only rendered route row leaves", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      marker("snoozed-header"),
      thread("z", "snoozed"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview(
      {
        items,
        settledOrder: ["s"],
        settledExpanded: true,
        snoozedThreadCount: 2,
      },
      "z",
      "a",
    );
    expect(result.get(sidebarMarkerId("snoozed-header"))).toEqual({ ...stationary, y: 83 });
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(46);
  });
});

describe("lifted card clearance", () => {
  const rect = (top: number, height: number) => ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 260,
    width: 260,
  });
  const apply = (cardTop: number, cardHeight: number, y: number, listTop = 136, offset = 32) =>
    restrictBelowSidebarLabel(
      {
        transform: { ...stationary, y },
        containerNodeRect: rect(listTop, 500),
        draggingNodeRect: rect(cardTop, cardHeight),
        activatorEvent: null,
        active: null,
        activeNodeRect: null,
        over: null,
        overlayNodeRect: null,
        scrollableAncestors: [],
        scrollableAncestorRects: [],
        windowRect: null,
      },
      offset,
    );

  it.each([36, 82])("keeps a %ipx row below empty Pins even past the top edge", (height) => {
    for (const pointerY of [150, 136, 100, 0]) {
      const transform = apply(511, height, pointerY - 529);
      expect(511 + transform.y).toBe(168);
    }
  });

  it("preserves pointer movement below the label", () => {
    expect(apply(511, 36, -200).y).toBe(-200);
  });

  it("follows the list when it scrolls and includes content preceding Pins", () => {
    expect(511 + apply(511, 36, -500, 96).y).toBe(128);
    expect(511 + apply(511, 36, -500, 136, 114).y).toBe(250);
  });
});

describe("task block drag projection", () => {
  const environmentId = EnvironmentId.make("local");
  const taskRef = scopeTaskRef(environmentId, TaskId.make("task"));
  const taskKey = "owner";
  const items: TaskSidebarItem[] = [
    {
      kind: "task",
      key: "task",
      taskKey,
      taskRef,
      section: "active",
      expanded: true,
      counts: { live: 1, snoozed: 0, settled: 1 },
      status: "idle",
      settleBlocked: false,
      timeLabel: "just now",
    },
    {
      kind: "thread",
      key: "member",
      taskKey,
      threadRef: scopeThreadRef(environmentId, ThreadId.make("member")),
      section: "active",
    },
    {
      kind: "draft",
      key: "draft",
      taskKey,
      draft: {
        key: "draft",
        environmentId,
        projectId: ProjectId.make("project"),
        taskId: taskRef.taskId,
      },
      section: "active",
    },
    { kind: "task-thread-limit", key: "new", taskKey, taskRef, count: 10, showAll: true },
    { kind: "task-settled-header", key: "shelf", taskKey, taskRef, count: 1, expanded: true },
    {
      kind: "thread",
      key: "settled",
      taskKey,
      threadRef: scopeThreadRef(environmentId, ThreadId.make("settled")),
      section: "settled",
    },
    {
      kind: "thread",
      key: "free",
      threadRef: scopeThreadRef(environmentId, ThreadId.make("free")),
      section: "active",
    },
  ];
  function taskLayout(activeIndex: number, overIndex: number, scale = 1) {
    let top = 100;
    const rects = [82, 82, 36, 28, 28, 36, 82].map((height) => {
      height *= scale;
      const rect = { top, bottom: top + height, height, left: 0, right: 260, width: 260 };
      top += height;
      return rect;
    });
    return {
      rects,
      activeIndex,
      overIndex,
      index: 0,
      activeNodeRect: rects[activeIndex]!,
    } satisfies Parameters<SortingStrategy>[0];
  }
  it("collapses all dragged task children and restores the original inventory after dragging", () => {
    const visible = collapseDraggedTask(items, "task");
    expect(visible.map(taskSidebarItemId)).toEqual(["task", "free"]);
    expect(visible[0]).toMatchObject({ expanded: false });
    expect(items[0]).toMatchObject({ expanded: true });
    expect(collapseDraggedTask(items, null)).toBe(items);
  });
  it("keeps an already collapsed task collapsed after dragging, including retained selected rows", () => {
    const collapsed = items.flatMap<TaskSidebarItem>((item) => {
      if (item.kind === "task") return [{ ...item, expanded: false }];
      return ["member", "free"].includes(taskSidebarItemId(item)) ? [item] : [];
    });
    expect(collapseDraggedTask(collapsed, "task").map(taskSidebarItemId)).toEqual(["task", "free"]);
    expect(collapseDraggedTask(collapsed, null)).toBe(collapsed);
    expect(collapsed[0]).toMatchObject({ expanded: false });
  });
  it("leaves task expansion alone when dragging a member or an unrelated thread", () => {
    for (const active of ["member", "free", "missing"]) {
      expect(collapseDraggedTask(items, active)).toBe(items);
    }
  });
  it.each([1, 2])("reserves only the dragged task card at scale %s", (scale) => {
    const visible = collapseDraggedTask(items, "task");
    const strategy = createTaskSidebarSortingStrategy({ items: visible, placement: "after" });
    const rects = [0, 1].map((index) => ({
      top: 100 + index * 82 * scale,
      bottom: 100 + (index + 1) * 82 * scale,
      height: 82 * scale,
      left: 0,
      right: 260,
      width: 260,
    }));
    const args = { rects, activeIndex: 0, overIndex: 1, activeNodeRect: rects[0]! };
    expect(strategy({ ...args, index: 1 })).toEqual({ ...stationary, y: -82 * scale });
  });
  it.each([1, 2])(
    "moves the complete expanded block with measured structural geometry at scale %s",
    (scale) => {
      const strategy = createTaskSidebarSortingStrategy({ items, placement: "after" });
      const args = taskLayout(0, 6, scale);
      const projected = items.map((_, index) => strategy({ ...args, index }));
      expect(projected[0]).toEqual(stationary);
      expect(projected[6]).toEqual({ ...stationary, y: -292 * scale });
      expect(projected.slice(1, 6).every((transform) => transform?.y === 82 * scale)).toBe(true);
    },
  );
  it("keeps every child with the lifted header while the surrounding rows reserve the whole block", () => {
    const strategy = createTaskSidebarSortingStrategy({
      items,
      placement: "after",
      activeOffsetY: () => 147,
    });
    const args = taskLayout(0, 6);
    expect(items.slice(1, 6).map((_, index) => strategy({ ...args, index: index + 1 })?.y)).toEqual(
      [147, 147, 147, 147, 147],
    );
    expect(strategy({ ...args, index: 6 })?.y).toBe(-292);
  });
  it.each([
    ["the pickup card", 0],
    ["no collision", -1],
    ["an invalid child target", 1],
  ] as const)("keeps the complete lifted block together over %s", (_, overIndex) => {
    const strategy = createTaskSidebarSortingStrategy({ items, activeOffsetY: () => 147 });
    const args = taskLayout(0, overIndex);
    expect(strategy({ ...args, index: 0 })).toEqual(stationary);
    expect(items.slice(1, 6).map((_, index) => strategy({ ...args, index: index + 1 }))).toEqual(
      Array.from({ length: 5 }, () => ({ ...stationary, y: 147 })),
    );
    expect(strategy({ ...args, index: 6 })).toEqual(stationary);
  });
  it("reuses layout projection across pointer deltas and invalidates geometry and targets", () => {
    const resolve = vi.spyOn(taskSidebar, "resolveTaskSidebarDrop");
    let offset = 10;
    const strategy = createTaskSidebarSortingStrategy({
      items,
      placement: "after",
      activeOffsetY: () => offset,
    });
    const args = taskLayout(0, 6);
    try {
      for (const delta of [10, 30, 147]) {
        offset = delta;
        expect(strategy({ ...args, index: 0 })).toEqual(stationary);
        for (let index = 1; index < 6; index += 1) {
          expect(strategy({ ...args, index })).toEqual({ ...stationary, y: delta });
        }
        expect(strategy({ ...args, index: 6 })?.y).toBe(-292);
      }
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(strategy({ ...args, overIndex: 0, index: 6 })?.y).toBe(0);
      expect(resolve).toHaveBeenCalledTimes(2);
      const scaled = taskLayout(0, 6, 2);
      expect(strategy({ ...scaled, index: 6 })?.y).toBe(-584);
      expect(resolve).toHaveBeenCalledTimes(3);
      // Placement and inventory are closure inputs and recreate the strategy.
      const before = createTaskSidebarSortingStrategy({
        items,
        placement: "before",
        activeOffsetY: () => offset,
      });
      expect(before({ ...scaled, index: 6 })?.y).toBe(0);
      expect(resolve).toHaveBeenCalledTimes(4);
      const updated = createTaskSidebarSortingStrategy({ items: [...items], placement: "after" });
      expect(updated({ ...scaled, index: 6 })?.y).toBe(-584);
      expect(resolve).toHaveBeenCalledTimes(5);
    } finally {
      resolve.mockRestore();
    }
  });
  it("captures constrained deltas before children render in the installed DndContext", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const offset = createTaskSidebarDragOffset();
    const strategy = createTaskSidebarSortingStrategy({
      items,
      placement: "after",
      activeOffsetY: offset.read,
    });
    const args = taskLayout(0, 6);
    const resolve = vi.spyOn(taskSidebar, "resolveTaskSidebarDrop");
    const rendered: number[][] = [];
    let renderer: ReactTestRenderer | undefined;
    const onDragMove = vi.fn();
    function Children() {
      rendered.push(
        items.slice(1, 6).map((_, index) => strategy({ ...args, index: index + 1 })!.y),
      );
      return null;
    }
    try {
      for (const delta of [10, 30, 147, 0]) {
        // Feed a sensor-independent displacement through the real modifier pipeline.
        const displacement: Modifier = ({ transform }) => ({ ...transform, y: delta });
        const constrain: Modifier = ({ transform }) => ({
          ...transform,
          y: Math.min(transform.y, 100),
        });
        await act(() => {
          const tree = createElement(
            DndContext,
            { modifiers: [displacement, constrain, offset.capture], onDragMove },
            createElement(Children),
          );
          if (renderer) renderer.update(tree);
          else renderer = create(tree);
        });
        expect(rendered.at(-1)).toEqual(Array.from({ length: 5 }, () => Math.min(delta, 100)));
      }
      // Capturing does not depend on a post-render drag callback or recreate projection.
      expect(onDragMove).not.toHaveBeenCalled();
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      await act(() => renderer?.unmount());
      resolve.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it("keeps owned children aligned with the header when scrolling moves measured drop rectangles", () => {
    const offset = createTaskSidebarDragOffset();
    const strategy = createTaskSidebarSortingStrategy({
      items,
      placement: "after",
      activeOffsetY: offset.read,
    });
    const initial = taskLayout(0, 6);
    const args = {
      ...initial,
      rects: initial.rects.map((rect) => ({
        ...rect,
        top: rect.top - 40,
        bottom: rect.bottom - 40,
      })),
    };
    // The core applies this scroll delta after modifiers to the active header.
    expect(strategy({ ...args, index: 1 })?.y).toBe(40);
    expect(strategy({ ...args, index: 0 })).toEqual(stationary);
    // Remeasuring the draggable establishes the new scroll anchor.
    expect(strategy({ ...args, activeNodeRect: args.rects[0]!, index: 1 })?.y).toBe(0);
  });
  it("does not split task children when a top-level peer moves before the card", () => {
    const strategy = createTaskSidebarSortingStrategy({ items, placement: "before" });
    const args = taskLayout(6, 0);
    expect(items.slice(0, 6).map((_, index) => strategy({ ...args, index })?.y)).toEqual([
      82, 82, 82, 82, 82, 82,
    ]);
  });
  it("leaves membership hover and rejected nesting stationary", () => {
    const strategy = createTaskSidebarSortingStrategy({ items });
    for (const args of [taskLayout(6, 0), taskLayout(0, 1)]) {
      expect(
        items.map((item, index) => [taskSidebarItemId(item), strategy({ ...args, index })]),
      ).toEqual(items.map((item) => [taskSidebarItemId(item), stationary]));
    }
  });
  it("reserves slim task and member geometry when the whole block enters Settled", () => {
    const rows: TaskSidebarItem[] = [
      ...items,
      { kind: "marker", marker: "settled-header" },
      {
        kind: "thread",
        key: "parked",
        threadRef: scopeThreadRef(environmentId, ThreadId.make("parked")),
        section: "settled",
      },
    ];
    const initial = taskLayout(0, 8);
    const bottom = initial.rects.at(-1)!.bottom;
    const rect = (top: number, height: number) => ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 260,
      width: 260,
    });
    const args = { ...initial, rects: [...initial.rects, rect(bottom, 32), rect(bottom + 32, 36)] };
    const strategy = createTaskSidebarSortingStrategy({ items: rows, placement: "before" });
    expect(strategy({ ...args, index: 6 })?.y).toBe(-292);
    expect(strategy({ ...args, index: 7 })?.y).toBe(-292);
    expect(strategy({ ...args, index: 8 })?.y).toBe(-92);
    expect(strategy({ ...args, index: 1 })?.scaleY).toBe(36 / 82);
    expect(strategy({ ...args, index: 5 })?.scaleY).toBe(1);
  });
});
