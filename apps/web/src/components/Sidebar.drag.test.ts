import { describe, expect, it } from "vite-plus/test";
import { closestCenter, type CollisionDetection } from "@dnd-kit/core";
import type { SortingStrategy } from "@dnd-kit/sortable";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
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
  it("keeps the same pinned slot under the pointer when preview widths change", () => {
    const items = [
      pinnedHeader,
      thread("p1", "pinned"),
      thread("p2", "pinned"),
      thread("p3", "pinned"),
      thread("source", "pinned"),
    ];
    const rects = [
      { left: 0, top: 100, width: 260, height: 0, right: 260, bottom: 100 },
      ...[0, 88, 176].map((left) => ({
        left,
        top: 101,
        width: 84,
        height: 46,
        right: left + 84,
        bottom: 147,
      })),
      { left: 0, top: 151, width: 260, height: 46, right: 260, bottom: 197 },
    ];
    const droppableRects = new Map(items.map((item, i) => [sidebarListItemId(item), rects[i]!]));
    const args = {
      ...collisionArgs(),
      collisionRect: { left: 0, top: 125, width: 260, height: 46, right: 260, bottom: 171 },
      droppableRects,
      droppableContainers: items.map((item, i) => ({
        id: sidebarListItemId(item),
        key: sidebarListItemId(item),
        disabled: false,
        data: { current: {} },
        node: { current: null },
        rect: { current: rects[i]! },
      })),
      pointerCoordinates: { x: 42, y: 148 },
    } satisfies Parameters<CollisionDetection>[0];
    const detector = createSidebarCollisionDetection(() => true, {
      items,
      pinnedGrid: {
        columns: 3,
        rowHeight: 46,
        gap: 4,
        leading: 0,
        trailing: 8,
        width: 260,
        labelHeight: 24,
      },
    });
    expect(detector(args)[0]?.id).toBe("p1");
    droppableRects.set("p1", { ...rects[1]!, width: 260, right: 260 });
    droppableRects.set("source", { ...rects[4]!, width: 84, right: 84 });
    expect(detector(args)[0]?.id).toBe("p1");
  });

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

  it("picks the pinned tile under the pointer for a full-width card", () => {
    const rect = (left: number, top: number, width: number, height: number) => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    });
    const rects = new Map([
      ["p1", rect(0, 100, 140, 46)],
      ["p2", rect(144, 100, 116, 46)],
      ["card", rect(0, 200, 260, 82)],
    ]);
    // The card keeps its column, so its center sits nearer p1 while the pointer is over p2.
    const collisionRect = rect(0, 82, 260, 82);
    const detector = createSidebarCollisionDetection(() => true);
    const collisions = detector({
      active: {
        id: "card",
        data: { current: {} },
        rect: { current: { initial: rects.get("card")!, translated: collisionRect } },
      },
      collisionRect,
      droppableRects: rects,
      droppableContainers: [...rects].map(([id, current]) => ({
        id,
        key: id,
        disabled: false,
        data: { current: {} },
        node: { current: null },
        rect: { current },
      })),
      pointerCoordinates: { x: 220, y: 120 },
    });
    expect(collisions[0]?.id).toBe("p2");
  });
});

describe("sidebar drag projection", () => {
  it.each([
    ["a2", "a1"],
    ["p", "a1"],
    ["s", sidebarMarkerId("pinned-header")],
    ["z", sidebarMarkerId("settled-header")],
  ])("restores every row and marker when dragging %s out after hovering %s", (active, over) => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      marker("active-placeholder"),
      thread("a1", "active"),
      thread("a2", "active"),
      marker("snoozed-header"),
      thread("z", "snoozed"),
      settledHeader,
      marker("settled-placeholder"),
      thread("s", "settled"),
    ];
    const input = {
      items,
      settledOrder: ["z", "s"],
      settledExpanded: true,
      boundaryLabelHeight: 24,
      snoozedThreadCount: 1,
    };
    const reordered = preview(input, active, over);
    expect([...reordered.values()].some((transform) => transform?.y !== 0)).toBe(true);

    const restored = preview({ ...input, enabled: false }, active, over);
    for (const transform of restored.values()) expect(transform).toEqual(stationary);

    expect(preview({ ...input, enabled: true }, active, over)).toEqual(reordered);
  });

  it.each([
    ["a1", "a2"],
    ["a1", sidebarMarkerId("settled-header")],
    ["z", "a2"],
  ])("keeps sparse shelves at the bottom when dragging %s over %s", (active, over) => {
    const items = [
      pinnedHeader,
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      marker("snoozed-header"),
      thread("z", "snoozed"),
      settledHeader,
      thread("s", "settled"),
    ];
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: over === sidebarMarkerId("settled-header") ? ["a1", "s"] : ["s"],
      settledExpanded: true,
      boundaryLabelHeight: 24,
      snoozedThreadCount: 1,
    });
    const args = layout(items, active, over);
    for (const rect of args.rects.slice(4)) {
      rect.top += 400;
      rect.bottom += 400;
    }
    const lastIndex = items.length - 1;
    expect(strategy({ ...args, index: lastIndex })).toEqual(stationary);
  });

  const pinned = [
    pinnedHeader,
    thread("p1", "pinned"),
    thread("p2", "pinned"),
    divider,
    thread("a1", "active"),
    settledHeader,
    thread("s1", "settled"),
  ];

  it("holds pins in place when a lower pin moves to the top", () => {
    const result = preview(
      { items: pinned, settledOrder: [], settledExpanded: true },
      "p2",
      sidebarMarkerId("pinned-header"),
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get("p1")).toEqual(stationary);
    expect(result.get(sidebarMarkerId("pinned-divider"))).toEqual(stationary);
    expect(result.get("a1")).toEqual(stationary);
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
    [sidebarMarkerId("pinned-divider"), 83, 83],
    ["a1", 0, 83],
    ["a2", 0, 0],
  ] as const)(
    "opens the active pointer slot over %s and keeps the pin's cell until the drop",
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
      expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(0);
      expect(result.get("a1")?.y).toBe(a1Offset);
      expect(result.get("a2")?.y).toBe(a2Offset);
      expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(83);
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

  it.each(["p", "s"])("replaces the empty Active target when %s enters", (active) => {
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
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(0);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(82);
  });

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

  it("previews a time-ordered inbox drop at its time slot, above the Working shelf", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      marker("working-header"),
      thread("w", "working"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const input = { items, settledOrder: [], settledExpanded: false };
    expect(preview(input, "p", "a1").get("a2")?.y).toBe(83);
    const byTime = preview({ ...input, activeOrder: ["a1", "a2", "p"] }, "p", "a1");
    expect(byTime.get("a2")).toEqual(stationary);
    expect(byTime.get(sidebarMarkerId("working-header"))?.y).toBe(83);
    expect(byTime.get("w")?.y).toBe(83);
  });

  it("updates the projection when the target or measured geometry changes", () => {
    const strategy = createSidebarSortingStrategy({
      items: pinned,
      settledOrder: [],
      settledExpanded: true,
    });
    const args = layout(pinned, "p1", "p1");
    expect(strategy({ ...args, index: 5 })?.y).toBe(0);
    expect(strategy({ ...args, index: 5, overIndex: 4 })?.y).toBe(83);
    const smaller = layout(pinned, "p1", "a1", 0.75);
    expect(strategy({ ...smaller, index: 5 })?.y).toBe(62.5);
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

describe("pinned grid projection", () => {
  const grid = {
    columns: 3,
    rowHeight: 46,
    gap: 4,
    leading: 0,
    trailing: 8,
    width: 260,
    labelHeight: 0,
  };
  const items = [
    pinnedHeader,
    thread("p1", "pinned"),
    thread("p2", "pinned"),
    thread("p3", "pinned"),
    thread("p4", "pinned"),
    divider,
    thread("a1", "active"),
    settledHeader,
    marker("settled-placeholder"),
  ];

  // Mirrors the CSS grid: full rows split the width, a short last row stretches.
  function gridPreview(active: string, over: string) {
    const width = 260;
    const pinnedKeys = items.flatMap((item) =>
      item.kind === "thread" && item.section === "pinned" ? [item.key] : [],
    );
    const rows = Math.ceil(pinnedKeys.length / grid.columns);
    let top = 100;
    const rects = items.map((item) => {
      const pinnedIndex = item.kind === "thread" ? pinnedKeys.indexOf(item.key) : -1;
      if (pinnedIndex >= 0) {
        const row = Math.floor(pinnedIndex / grid.columns);
        const inRow = Math.min(grid.columns, pinnedKeys.length - row * grid.columns);
        const cell = (width - (inRow - 1) * grid.gap) / inRow;
        const left = (pinnedIndex % grid.columns) * (cell + grid.gap);
        const rowTop = top + grid.leading + row * (grid.rowHeight + grid.gap);
        const rect = {
          top: rowTop,
          height: grid.rowHeight,
          bottom: rowTop + grid.rowHeight,
          left,
          right: left + cell,
          width: cell,
        };
        if (pinnedIndex === pinnedKeys.length - 1) {
          top += grid.leading + rows * grid.rowHeight + (rows - 1) * grid.gap + grid.trailing + 1;
        }
        return rect;
      }
      const height =
        item.kind === "thread"
          ? item.section === "active"
            ? 82
            : 36
          : item.marker === "settled-header"
            ? 32
            : 0;
      const rect = { top, height, bottom: top + height, left: 0, right: width, width };
      top += height + 1;
      return rect;
    });
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: [],
      settledExpanded: true,
      pinnedGrid: grid,
    });
    const activeIndex = items.findIndex((item) => sidebarListItemId(item) === active);
    const args = {
      activeIndex,
      overIndex: items.findIndex((item) => sidebarListItemId(item) === over),
      activeNodeRect: rects[activeIndex]!,
      rects,
      index: 0,
    } satisfies Parameters<SortingStrategy>[0];
    return new Map(
      items.map((item, index) => [sidebarListItemId(item), strategy({ ...args, index })]),
    );
  }

  it("opens the first cell live for the full-width last pin", () => {
    const result = gridPreview("p4", "p1");
    expect(result.get("p1")).toEqual({ ...stationary, x: 88 });
    expect(result.get("p2")).toEqual({ ...stationary, x: 88 });
    expect(result.get("p3")).toEqual({ ...stationary, x: -176, y: 50, scaleX: 260 / 84 });
    expect(result.get("p4")).toEqual(stationary);
  });

  it.each([
    ["a1", "p2", "a card comes in"],
    ["p1", "a1", "a pin leaves"],
  ])("projects pinned cells while %s hovers %s (%s)", (active, over) => {
    const result = gridPreview(active, over);
    const expected =
      active === "a1"
        ? [
            stationary,
            { ...stationary, x: 88 },
            { ...stationary, x: -176, y: 50, scaleX: 128 / 84 },
            { ...stationary, x: 132, scaleX: 128 / 260 },
          ]
        : [stationary, stationary, stationary, stationary];
    for (const [index, key] of ["p1", "p2", "p3", "p4"].entries())
      expect(result.get(key), key).toEqual(expected[index]);
    expect(result.get(sidebarMarkerId("pinned-divider"))).toEqual(stationary);
  });
});

it.each([
  [0, sidebarMarkerId("pinned-divider")],
  [0, "a2"],
  [3, sidebarMarkerId("pinned-divider")],
] as const)("opens a grid row with %i pins over %s", (count, over) => {
  const items = [
    pinnedHeader,
    ...Array.from({ length: count }, (_, index) => thread(`p${index}`, "pinned")),
    divider,
    thread("a1", "active"),
    thread("a2", "active"),
  ];
  const strategy = createSidebarSortingStrategy({
    items,
    settledOrder: [],
    settledExpanded: true,
    pinnedGrid: {
      columns: 3,
      rowHeight: 46,
      gap: 4,
      leading: 0,
      trailing: 8,
      width: 260,
      labelHeight: 0,
    },
  });
  const args = layout(items, "a2", over);
  const nextRows = Math.ceil((count + 1) / 3);
  const previousHeight = count * 83;
  const displacement = nextRows * 50 + 5 - previousHeight;
  expect(strategy({ ...args, index: count + 1 })?.y).toBe(displacement);
  expect(strategy({ ...args, index: count + 2 })?.y).toBe(displacement);
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
  const apply = (
    cardTop: number,
    cardHeight: number,
    y: number,
    listTop = 136,
    offset = 32,
    containerTop = listTop,
  ) =>
    restrictBelowSidebarLabel(
      {
        transform: { ...stationary, y },
        containerNodeRect: rect(containerTop, 500),
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
      listTop,
    );

  it.each([36, 82])("keeps a %ipx row below empty Pins even past the top edge", (height) => {
    for (const pointerY of [150, 136, 100, 0]) {
      const transform = apply(511, height, pointerY - 529);
      expect(511 + transform.y).toBe(168);
    }
  });

  // regression: #10453 the label clamp must not swallow drags that are already below it
  it("preserves pointer movement below the label", () => {
    expect(apply(511, 36, -200).y).toBe(-200);
  });

  it("follows the list when it scrolls and includes content preceding Pins", () => {
    expect(511 + apply(511, 36, -500, 96).y).toBe(128);
    expect(511 + apply(511, 36, -500, 136, 114).y).toBe(250);
    expect(511 + apply(511, 46, -500, 136, 114, 250).y).toBe(250);
  });
});
