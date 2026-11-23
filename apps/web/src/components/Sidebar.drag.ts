import { closestCenter, type CollisionDetection, type Modifier } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "./Sidebar.logic";

const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
const hidden = { ...stationary, scaleY: 0 };
type ThreadItem = Extract<SidebarListItem, { kind: "thread" }>;
type Layout = Parameters<SortingStrategy>[0];
const isShelfHeader = (item: SidebarListItem | undefined) =>
  item?.kind === "marker" &&
  (item.marker === "working-header" ||
    item.marker === "snoozed-header" ||
    item.marker === "settled-header");

const SCROLL_VIEWPORT = '[data-slot="scroll-area-viewport"]';

/** A scroll area inside the sidebar's own, such as the Settled shelf's. */
export function isNestedSidebarScroller(element: Element) {
  return element.parentElement?.closest(SCROLL_VIEWPORT) != null;
}

/** Keeps the lifted row inside the sidebar's scroll area; a nested shelf scroller would trap it. */
export const restrictToSidebarViewport: Modifier = ({
  transform,
  draggingNodeRect,
  scrollableAncestors,
  scrollableAncestorRects,
}) => {
  const bounds =
    scrollableAncestorRects[
      scrollableAncestors.findIndex((element) => !isNestedSidebarScroller(element))
    ];
  if (!draggingNodeRect || !bounds) return transform;
  const y = Math.min(
    Math.max(transform.y, bounds.top - draggingNodeRect.top),
    bounds.top + bounds.height - draggingNodeRect.bottom,
  );
  const x = Math.min(
    Math.max(transform.x, bounds.left - draggingNodeRect.left),
    bounds.left + bounds.width - draggingNodeRect.right,
  );
  return { ...transform, x, y };
};

/**
 * Leaves out rows a nested scroller has scrolled out of view. Their rects still overlap the
 * rows around the scroller, so they would otherwise win collisions there.
 */
export function excludeScrolledOutRows(detect: CollisionDetection): CollisionDetection {
  return (args) => {
    const bounds = new Map<Element, DOMRect>();
    const droppableContainers = args.droppableContainers.filter((container) => {
      const scroller = container.node.current?.parentElement?.closest(SCROLL_VIEWPORT);
      if (!scroller || !isNestedSidebarScroller(scroller)) return true;
      let visible = bounds.get(scroller);
      if (visible === undefined) {
        visible = scroller.getBoundingClientRect();
        bounds.set(scroller, visible);
      }
      const rect = args.droppableRects.get(container.id);
      if (!rect) return false;
      const middle = rect.top + rect.height / 2;
      return middle >= visible.top && middle <= visible.bottom;
    });
    return detect({ ...args, droppableContainers });
  };
}

export function restrictBelowSidebarLabel(
  { transform, containerNodeRect, draggingNodeRect }: Parameters<Modifier>[0],
  offset: number,
) {
  if (!containerNodeRect || !draggingNodeRect) return transform;
  const minimumY = containerNodeRect.top + offset - draggingNodeRect.top;
  return transform.y < minimumY ? { ...transform, y: minimumY } : transform;
}

export function createSidebarCollisionDetection(
  isValidTarget: (id: string) => boolean,
  options: {
    items?: readonly SidebarListItem[];
    activationY?: number | null;
  } = {},
): CollisionDetection {
  const validity = new Map<string, boolean>();
  const sections = new Map<string, SidebarSection | null>();
  let previousPointerY = options.activationY;
  let boundarySection: "pinned" | "active" | undefined;
  return (args) => {
    let collisions = closestCenter(args);
    const pointer = args.pointerCoordinates;
    const items = options.items;
    const source = items?.find((item) => item.kind === "thread" && item.key === args.active.id);
    const boundary = args.droppableContainers
      .find((container) => container.id === sidebarMarkerId("pinned-divider"))
      ?.node.current?.querySelector(".sidebar-drag-boundary-label")
      ?.getBoundingClientRect();
    if (items && boundary && source?.kind === "thread" && pointer) {
      boundarySection ??= source.section === "pinned" ? "pinned" : "active";
      // Only pointer movement changes sections; opening the destination moves rows under stationary gestures.
      const previousY = previousPointerY ?? pointer.y;
      previousPointerY = pointer.y;
      if (pointer.x >= boundary.left && pointer.x <= boundary.right) {
        if (pointer.y < previousY && pointer.y <= boundary.bottom) boundarySection = "pinned";
        else if (pointer.y > previousY && pointer.y >= boundary.top) boundarySection = "active";
        const nextHeader = (["working-header", "snoozed-header", "settled-header"] as const)
          .map((marker) =>
            args.droppableContainers.find((container) => container.id === sidebarMarkerId(marker)),
          )
          .find((container) => container !== undefined);
        const activeBottom = nextHeader?.node.current?.getBoundingClientRect().top;
        if (boundarySection === "pinned" || (activeBottom != null && pointer.y < activeBottom)) {
          const target = collisions.find((collision) => {
            const id = String(collision.id);
            if (!sections.has(id)) {
              sections.set(
                id,
                resolveSidebarDropTarget(items, String(args.active.id), id)?.section ?? null,
              );
            }
            return sections.get(id) === boundarySection;
          });
          if (target)
            collisions = [target, ...collisions.filter((collision) => collision !== target)];
        }
      }
    }
    const nearest = collisions[0];
    if (!nearest || nearest.id === args.active.id) {
      return collisions;
    }
    const id = String(nearest.id);
    const valid = validity.get(id) ?? isValidTarget(id);
    validity.set(id, valid);
    return valid ? collisions : collisions.filter((collision) => collision.id === args.active.id);
  };
}

export function createSidebarSortingStrategy(input: {
  items: readonly SidebarListItem[];
  enabled?: boolean;
  settledOrder: readonly string[];
  activeOrder?: readonly string[];
  settledExpanded: boolean;
  settledVisibleCount?: number;
  routeThreadKey?: string | null;
  snoozedThreadCount?: number;
  /**
   * Rows the Settled shelf's own scroller shows. Its rows then sit inside the Settled header's
   * element, move with it, and fill no more than this many rows of the list.
   */
  settledShelfRows?: number;
  cardHeight?: number;
  slimHeight?: number;
  boundaryLabelHeight?: number;
}): SortingStrategy {
  if (input.enabled === false) return () => stationary;
  const { items } = input;
  const indices = new Map(items.map((item, index) => [sidebarListItemId(item), index]));
  let previous: Pick<Layout, "rects" | "activeIndex" | "overIndex"> | undefined;
  let transforms: ReturnType<SortingStrategy>[] | null = [];

  function project({ rects, activeIndex, overIndex }: Layout) {
    const active = items[activeIndex];
    const over = items[overIndex] ?? active;
    if (active?.kind !== "thread" || !over || !rects[0]) return [];
    const target = resolveSidebarDropTarget(items, active.key, sidebarListItemId(over));
    if (!target) return [];
    const groups: Record<SidebarSection, ThreadItem[]> = {
      pinned: [],
      active: [],
      working: [],
      snoozed: [],
      settled: [],
    };
    let cardHeight = input.cardHeight;
    let slimHeight = input.slimHeight;
    let headerScale: number | undefined;
    for (const [index, item] of items.entries()) {
      if (item.kind === "marker") {
        if (isShelfHeader(item)) {
          const height = rects[index]?.height;
          if (height) headerScale ??= height / 32;
        }
        continue;
      }
      if (item.section === "pinned" || item.section === "active" || item.section === "working")
        cardHeight ??= rects[index]?.height;
      else slimHeight ??= rects[index]?.height;
      if (item.key !== active.key) groups[item.section].push(item);
    }
    const scale =
      slimHeight !== undefined ? slimHeight / 36 : (headerScale ?? (cardHeight ?? 82) / 82);
    cardHeight ??= 82 * scale;
    slimHeight ??= 36 * scale;
    const labelHeight = (input.boundaryLabelHeight ?? 0) * scale;
    const group = groups[target.section];
    const order =
      target.section === "pinned"
        ? target.pinnedOrder
        : target.section === "settled"
          ? input.settledOrder
          : (input.activeOrder ?? target.activeOrder);
    const ranks = new Map(order.map((key, index) => [key, index]));
    const rank = ranks.get(active.key) ?? Number.POSITIVE_INFINITY;
    const index = group.findIndex(
      (item) => (ranks.get(item.key) ?? Number.POSITIVE_INFINITY) > rank,
    );
    group.splice(index < 0 ? group.length : index, 0, { ...active, section: target.section });
    const settledOrder = (
      input.settledOrder.length > 0 ? input.settledOrder : groups.settled.map((item) => item.key)
    ).filter((key) => key !== active.key || target.section === "settled");
    const visible = input.settledExpanded
      ? settledOrder.slice(0, input.settledVisibleCount ?? settledOrder.length)
      : [];
    const routeKey = input.routeThreadKey;
    if (routeKey && settledOrder.includes(routeKey) && !visible.includes(routeKey)) {
      visible.push(routeKey);
    }
    groups.settled = visible.map((key) => ({ kind: "thread", key, section: "settled" }));
    const projected: SidebarListItem[] = [];
    const marker = (name: SidebarListMarker) => projected.push({ kind: "marker", marker: name });
    const section = (name: "active" | "settled") => {
      if (groups[name].length > 0) projected.push(...groups[name]);
      else marker(`${name}-placeholder`);
    };
    marker("pinned-header");
    projected.push(...groups.pinned);
    marker("pinned-divider");
    section("active");
    if (items.some((item) => item.kind === "marker" && item.marker === "working-header")) {
      marker("working-header");
      projected.push(...groups.working);
    }
    if (
      groups.snoozed.length > 0 ||
      ((active.section !== "snoozed" || (input.snoozedThreadCount ?? 0) > 1) &&
        items.some((item) => item.kind === "marker" && item.marker === "snoozed-header"))
    ) {
      marker("snoozed-header");
      projected.push(...groups.snoozed);
    }
    marker("settled-header");
    section("settled");
    const heights = projected.map((item) => {
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      const fallback =
        item.kind === "thread" &&
        (item.section === "pinned" || item.section === "active" || item.section === "working")
          ? cardHeight
          : slimHeight;
      const moved = item.kind === "thread" && item.key === active.key;
      return item.kind === "marker" &&
        (item.marker === "pinned-header" || item.marker === "pinned-divider")
        ? labelHeight
        : item.kind === "marker" && item.marker.endsWith("placeholder")
          ? slimHeight
          : moved
            ? fallback
            : (rect?.height ?? fallback);
    });
    const isSettledRow = (item: SidebarListItem | undefined) =>
      item?.kind === "thread" && item.section === "settled";
    const headerIndex = indices.get(sidebarMarkerId("settled-header"));
    const headerRect = headerIndex === undefined ? undefined : rects[headerIndex];
    const firstSettledRect = rects[items.findIndex(isSettledRow)];
    const lastSettledRect = rects[items.findLastIndex(isSettledRow)];
    // Settled rows scroll in their own shelf right below the header, so their rects sit that
    // scroll offset above where the projection lays them out.
    const settledScroll =
      headerRect && firstSettledRect
        ? Math.max(0, headerRect.bottom + 1 - firstSettledRect.top)
        : 0;
    const shelfCap =
      input.settledShelfRows === undefined
        ? Number.POSITIVE_INFINITY
        : input.settledShelfRows * slimHeight;
    const settledHeight =
      firstSettledRect && lastSettledRect ? lastSettledRect.bottom - firstSettledRect.top : 0;
    const projectedSettledHeight = projected.reduce(
      (sum, item, index) => (isSettledRow(item) ? sum + heights[index]! + 1 : sum),
      -1,
    );
    const firstShelf = items.findIndex(isShelfHeader);
    const shelfRect = rects[firstShelf];
    const beforeShelf = rects[firstShelf - 1];
    const lastRect = rects.at(-1);
    const listBottom =
      firstSettledRect && isSettledRow(items.at(-1))
        ? firstSettledRect.top + settledScroll + Math.min(settledHeight, shelfCap)
        : lastRect?.bottom;
    let shelfSpace =
      shelfRect && beforeShelf && listBottom !== undefined && shelfRect.top > beforeShelf.bottom + 1
        ? Math.max(
            0,
            listBottom -
              rects[0].top -
              heights.reduce((sum, height) => sum + height + 1, -1) +
              Math.max(0, projectedSettledHeight - shelfCap),
          )
        : 0;
    // A shelf that loses rows scrolls back to its new end, as the browser clamps it on drop.
    const projectedScroll =
      input.settledShelfRows === undefined
        ? settledScroll
        : Math.min(settledScroll, Math.max(0, projectedSettledHeight - shelfCap));
    const result = items.map(() => hidden);
    let top = rects[0].top;
    let headerShift = 0;
    for (const [projectedIndex, item] of projected.entries()) {
      if (isShelfHeader(item)) {
        top += shelfSpace;
        shelfSpace = 0;
      }
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index !== undefined && rect) {
        let y = top - rect.top;
        if (index === headerIndex) headerShift = y;
        else if (isSettledRow(item)) {
          y -= projectedScroll + (input.settledShelfRows === undefined ? 0 : headerShift);
        }
        result[index] = { ...stationary, y };
      }
      top += heights[projectedIndex]! + 1;
    }
    result[activeIndex] = stationary;
    return result;
  }

  return (args) => {
    if (
      previous?.rects !== args.rects ||
      previous.activeIndex !== args.activeIndex ||
      previous.overIndex !== args.overIndex
    ) {
      previous = args;
      transforms = project(args);
    }
    return transforms === null
      ? verticalListSortingStrategy(args)
      : (transforms[args.index] ?? stationary);
  };
}
