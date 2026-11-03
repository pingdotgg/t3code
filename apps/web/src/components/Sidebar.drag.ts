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

export function restrictBelowSidebarLabel(
  { transform, containerNodeRect, draggingNodeRect }: Parameters<Modifier>[0],
  offset: number,
  listTop = containerNodeRect?.top,
) {
  if (listTop === undefined || !draggingNodeRect) return transform;
  const minimumY = listTop + offset - draggingNodeRect.top;
  return transform.y < minimumY ? { ...transform, y: minimumY } : transform;
}

export function createSidebarCollisionDetection(
  isValidTarget: (id: string) => boolean,
  options: {
    items?: readonly SidebarListItem[];
    activationY?: number | null;
    pinnedGrid?: SidebarPinnedGrid | undefined;
  } = {},
): CollisionDetection {
  const validity = new Map<string, boolean>();
  const sections = new Map<string, SidebarSection | null>();
  let previousPointerY = options.activationY;
  let boundarySection: "pinned" | "active" | undefined;
  const pins =
    options.items?.filter(
      (item): item is ThreadItem => item.kind === "thread" && item.section === "pinned",
    ) ?? [];
  return (args) => {
    const pointer = args.pointerCoordinates;
    let droppableRects = args.droppableRects;
    const grid = options.pinnedGrid;
    const header = args.droppableRects.get(sidebarMarkerId("pinned-header"));
    if (grid && header && pins.length > 0) {
      droppableRects = new Map(args.droppableRects);
      for (const [index, pin] of pins.entries()) {
        const cell = sidebarPinnedGridCell(grid, index, pins.length);
        const left = header.left + cell.left;
        const top = header.top + grid.labelHeight + 1 + grid.leading + cell.top;
        droppableRects.set(pin.key, {
          left,
          top,
          width: cell.width,
          height: grid.rowHeight,
          right: left + cell.width,
          bottom: top + grid.rowHeight,
        });
      }
    }
    // Rows span the list, so only pinned grid columns feel the pointer's x; cards keep their column.
    let collisions = closestCenter(
      pointer
        ? {
            ...args,
            droppableRects,
            collisionRect: {
              ...args.collisionRect,
              left: pointer.x - args.collisionRect.width / 2,
              right: pointer.x + args.collisionRect.width / 2,
              top: pointer.y - args.collisionRect.height / 2,
              bottom: pointer.y + args.collisionRect.height / 2,
            },
          }
        : args,
    );
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

/** Pinned tile grid geometry in client pixels, measured when a drag starts. */
export type SidebarPinnedGrid = {
  readonly width: number;
  readonly labelHeight: number;
  readonly columns: number;
  readonly rowHeight: number;
  readonly gap: number;
  readonly leading: number;
  readonly trailing: number;
};

export function sidebarPinnedGridCell(grid: SidebarPinnedGrid, index: number, count: number) {
  const row = Math.floor(index / grid.columns);
  const columns = Math.min(grid.columns, count - row * grid.columns);
  const width = (grid.width - (columns - 1) * grid.gap) / columns;
  return {
    left: (index % grid.columns) * (width + grid.gap),
    top: row * (grid.rowHeight + grid.gap),
    width,
  };
}

/** Reads the pinned grid's CSS-driven columns and spacing; `scale` maps CSS to client pixels. */
export function measureSidebarPinnedGrid(
  grid: HTMLElement,
  scale: number,
  labelHeight = 0,
): SidebarPinnedGrid | undefined {
  const style = getComputedStyle(grid);
  const rowHeight = Number.parseFloat(style.gridAutoRows);
  if (!Number.isFinite(rowHeight)) return undefined;
  const tile = grid.firstElementChild;
  const columns = tile
    ? Number.parseInt(getComputedStyle(tile).getPropertyValue("--sidebar-pinned-columns"), 10)
    : 1;
  const px = (value: string) => (Number.parseFloat(value) || 0) * scale;
  return {
    width:
      grid.getBoundingClientRect().width ||
      (grid.parentElement?.getBoundingClientRect().width ?? 0) -
        px(style.marginLeft) -
        px(style.marginRight),
    labelHeight,
    columns: Number.isFinite(columns) && columns > 0 ? columns : 1,
    rowHeight: rowHeight * scale,
    gap: px(style.rowGap),
    leading: px(style.marginTop) + px(style.borderTopWidth) + px(style.paddingTop),
    trailing: px(style.paddingBottom) + px(style.borderBottomWidth) + px(style.marginBottom),
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
  cardHeight?: number;
  slimHeight?: number;
  boundaryLabelHeight?: number;
  /** Omitted, pinned rows stack like cards: one column at their own height. */
  pinnedGrid?: SidebarPinnedGrid | undefined;
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
    let pinnedHeight: number | undefined;
    let headerScale: number | undefined;
    for (const [index, item] of items.entries()) {
      if (item.kind === "marker") {
        if (isShelfHeader(item)) {
          const height = rects[index]?.height;
          if (height) headerScale ??= height / 32;
        }
        continue;
      }
      if (item.section === "pinned") pinnedHeight ??= rects[index]?.height;
      else if (item.section === "active" || item.section === "working")
        cardHeight ??= rects[index]?.height;
      else slimHeight ??= rects[index]?.height;
      if (item.key !== active.key) groups[item.section].push(item);
    }
    if (!input.pinnedGrid) cardHeight ??= pinnedHeight;
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
    const pinnedGrid = input.pinnedGrid ?? {
      columns: 1,
      width: rects[0].width,
      labelHeight: 0,
      rowHeight: pinnedHeight ?? cardHeight,
      gap: 1,
      leading: 0,
      trailing: 0,
    };
    // An outgoing pin leaves its cell; an incoming pin reserves its destination row.
    const restingPins = items.flatMap((item, index) =>
      item.kind === "thread" && item.section === "pinned" ? [index] : [],
    );
    const pinnedRows = Math.ceil(
      Math.max(
        restingPins.length,
        target.section === "pinned" ? groups.pinned.length : 0,
        input.pinnedGrid && restingPins.length === 0 ? 1 : 0,
      ) / pinnedGrid.columns,
    );
    // The grid hides when empty, so it adds no list gap either.
    const pinnedBlock =
      pinnedRows === 0
        ? 0
        : pinnedGrid.leading +
          pinnedRows * pinnedGrid.rowHeight +
          (pinnedRows - 1) * pinnedGrid.gap +
          pinnedGrid.trailing +
          1;
    const heights = projected.map((item) => {
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      const fallback =
        item.kind === "thread" && (item.section === "active" || item.section === "working")
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
    const firstShelf = items.findIndex(isShelfHeader);
    const shelfRect = rects[firstShelf];
    const beforeShelf = rects[firstShelf - 1];
    const lastRect = rects.at(-1);
    let shelfSpace =
      shelfRect && beforeShelf && lastRect && shelfRect.top > beforeShelf.bottom + 1
        ? Math.max(
            0,
            lastRect.bottom -
              rects[0].top -
              heights.reduce((sum, height) => sum + height + 1, -1) -
              pinnedBlock,
          )
        : 0;
    const result = items.map(() => hidden);
    const firstPin = rects[restingPins[0] ?? -1];
    let top = rects[0].top;
    for (const [flowIndex, item] of projected.entries()) {
      if (isShelfHeader(item)) {
        top += shelfSpace;
        shelfSpace = 0;
      }
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
      top += heights[flowIndex]! + 1;
      if (item.kind === "marker" && item.marker === "pinned-header") {
        const y = firstPin ? top + pinnedGrid.leading - firstPin.top : 0;
        for (const pin of restingPins) result[pin] = { ...stationary, y };
        if (input.pinnedGrid && target.section === "pinned") {
          for (const [position, pin] of groups.pinned.entries()) {
            const pinIndex = indices.get(pin.key);
            if (pinIndex === undefined || pinIndex === activeIndex) continue;
            const from = sidebarPinnedGridCell(
              input.pinnedGrid,
              restingPins.indexOf(pinIndex),
              restingPins.length,
            );
            const to = sidebarPinnedGridCell(input.pinnedGrid, position, groups.pinned.length);
            result[pinIndex] = {
              ...stationary,
              x: to.left - from.left,
              y: y + to.top - from.top,
              scaleX: to.width / from.width,
            };
          }
        }
        top += pinnedBlock;
      }
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
