import { describe, expect, it, vi } from "vite-plus/test";
import { closestCenter, type CollisionDetection } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import { createSidebarCollisionDetection, createSidebarSortingStrategy } from "./Sidebar.drag";
import {
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
          : (item.marker.endsWith("placeholder") ? 36 : 32) * scale;
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

  function clampedArgs() {
    const args = collisionArgs();
    const pinned = args.droppableRects.get(sidebarMarkerId("pinned-header"))!;
    const source = args.droppableRects.get("source")!;
    const collisionRect = {
      ...source,
      top: pinned.top - 8,
      bottom: pinned.top - 8 + source.height,
    };
    return {
      ...args,
      active: {
        ...args.active,
        rect: { current: { initial: source, translated: collisionRect } },
      },
      collisionRect,
      pointerCoordinates: { x: pinned.left + pinned.width / 2, y: pinned.top + 8 },
    };
  }

  it("reaches empty Pins with an upward pointer while the card is clamped at the top", () => {
    const args = clampedArgs();
    const detector = createSidebarCollisionDetection(() => true, {
      emptyPins: true,
      activationY: args.pointerCoordinates.y + 6,
    });
    expect(args.droppableRects.get(sidebarMarkerId("pinned-header"))?.height).toBe(0);
    expect(closestCenter(args)[0]?.id).toBe("source");
    expect(detector(args)[0]?.id).toBe(sidebarMarkerId("pinned-header"));
  });

  it.each([
    { reason: "below the boundary cue", x: 130, y: 109, activationY: 140, emptyPins: true },
    { reason: "left of the list", x: -1, y: 108, activationY: 140, emptyPins: true },
    { reason: "right of the list", x: 261, y: 108, activationY: 140, emptyPins: true },
    { reason: "less than 6px upward", x: 130, y: 108, activationY: 113, emptyPins: true },
    { reason: "without an activation point", x: 130, y: 108, activationY: null, emptyPins: true },
    { reason: "with populated Pins", x: 130, y: 108, activationY: 140, emptyPins: false },
  ])("keeps ordinary collision behavior $reason", ({ x, y, activationY, emptyPins }) => {
    const detector = createSidebarCollisionDetection(() => true, { emptyPins, activationY });
    const args = { ...clampedArgs(), pointerCoordinates: { x, y } };
    expect(detector(args)[0]?.id).toBe("source");
  });

  it("keeps ordinary collision behavior without pointer coordinates", () => {
    const detector = createSidebarCollisionDetection(() => true, {
      emptyPins: true,
      activationY: 140,
    });
    expect(detector({ ...clampedArgs(), pointerCoordinates: null })[0]?.id).toBe("source");
  });

  it("validates the empty Pins override and caches an unsupported result", () => {
    const isValid = vi.fn(() => false);
    const detector = createSidebarCollisionDetection(isValid, {
      emptyPins: true,
      activationY: 140,
    });
    const args = clampedArgs();
    expect(detector(args).map((collision) => collision.id)).toEqual(["source"]);
    expect(detector(args).map((collision) => collision.id)).toEqual(["source"]);
    expect(isValid.mock.calls).toEqual([[sidebarMarkerId("pinned-header")]]);
  });

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
    for (let index = 0; index < pinned.length; index += 1) {
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
      expect(strategy({ ...args, index })).toEqual(verticalListSortingStrategy({ ...args, index }));
    }
  });

  it("leaves canonically sorted settled peers in place", () => {
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
    expect([...result.values()]).toEqual(items.map(() => stationary));
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
    ["p", -83, -37],
    ["s", 0, 46],
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

  it("uses measured placeholder sizing when card height differs from its default", () => {
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
