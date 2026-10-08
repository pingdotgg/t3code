import { closestCenter, type CollisionDetection, type Modifier } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import {
  isNestedSidebarListItem,
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
const isCardSection = (section: SidebarSection) =>
  section === "pinned" || section === "active" || section === "working";
const isShelfHeader = (item: SidebarListItem | undefined) =>
  item?.kind === "marker" &&
  (item.marker === "working-header" ||
    item.marker === "snoozed-header" ||
    item.marker === "settled-header");

/** Keep the lifted card below the Pins label, including when Pins is empty.
 * The container rect follows scrolling; the offset is measured once at pickup. */
export function restrictBelowSidebarLabel(
  { transform, containerNodeRect, draggingNodeRect }: Parameters<Modifier>[0],
  offset: number,
) {
  if (!containerNodeRect || !draggingNodeRect) return transform;
  const minimumY = containerNodeRect.top + offset - draggingNodeRect.top;
  return transform.y < minimumY ? { ...transform, y: minimumY } : transform;
}

/** Reject the nearest unsupported target without selecting another section.
 * Recreate this detector when drop eligibility changes. */
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
    // A lifted group moves past whole groups, so only rows that lead a block
    // are targets. Its own rows ride along with it. A launched row inside
    // another group would also shift as the preview moves that group, and
    // keep the target running ahead of the pointer.
    if (
      source?.kind === "thread" &&
      source.group !== undefined &&
      !isNestedSidebarListItem(source)
    ) {
      const nested = new Set(
        items!.flatMap((item) =>
          isNestedSidebarListItem(item) && item.kind === "thread" ? [item.key] : [],
        ),
      );
      collisions = collisions.filter((collision) => !nested.has(String(collision.id)));
    }
    const boundary = args.droppableContainers
      .find((container) => container.id === sidebarMarkerId("pinned-divider"))
      ?.node.current?.querySelector(".sidebar-drag-boundary-label")
      ?.getBoundingClientRect();
    if (items && boundary && source?.kind === "thread" && pointer) {
      boundarySection ??= source.section === "pinned" ? "pinned" : "active";
      // Use the visible divider row, including its sortable translation.
      // Only pointer movement can change sections: opening the destination
      // moves this row, but must not toggle a stationary gesture back.
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

/** Preview the committed section layout without moving or mounting DOM nodes.
 * A zero scaleY marks rows/markers to hide while retaining their measured nodes. */
export function createSidebarSortingStrategy(input: {
  items: readonly SidebarListItem[];
  /** Suspend the reorder preview while the thread is dragged out as context. */
  enabled?: boolean;
  settledOrder: readonly string[];
  /** Time-ordered inbox (Working beta): where the lifted row would land. */
  activeOrder?: readonly string[];
  settledExpanded: boolean;
  settledVisibleCount?: number;
  routeThreadKey?: string | null;
  snoozedThreadCount?: number;
  cardHeight?: number;
  slimHeight?: number;
  /** Space each pinned boundary opens for its label while dragging. The
   * markers stay zero height at rest, so nothing is reserved until pickup. */
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
    // Staying in its own group changes nothing, so nothing moves.
    if (!target || target.membership?.kind === "stay") return [];
    const membership = target.membership;
    // Nested rows ride along with their group's lead row: rows above the
    // lead (a group that moved to a live thread) go before it, the rest after.
    // A launched row lifted out of its group travels on its own.
    const leading = new Map<string, SidebarListItem[]>();
    const trailing = new Map<string, SidebarListItem[]>();
    const nestedKeys = new Set<string>();
    let lead: string | null = null;
    let pending: SidebarListItem[] | null = null;
    for (const item of items) {
      if (item === active && isNestedSidebarListItem(item)) continue;
      if (!isNestedSidebarListItem(item)) {
        lead = sidebarListItemId(item);
        if (pending !== null) leading.set(lead, pending);
        pending = null;
        continue;
      }
      if (item.kind === "thread") nestedKeys.add(item.key);
      if (item.kind === "thread" && item.key === item.group) pending = [item];
      else if (pending !== null) pending.push(item);
      else if (lead !== null) trailing.set(lead, [...(trailing.get(lead) ?? []), item]);
    }
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
      if (isNestedSidebarListItem(item)) continue;
      // A group's top row also holds the group header, so it is taller.
      if (item.group === undefined) {
        if (item.section === "pinned" || item.section === "active" || item.section === "working")
          cardHeight ??= rects[index]?.height;
        else slimHeight ??= rects[index]?.height;
      }
      if (item.key !== active.key) groups[item.section].push(item);
    }
    // Cards are 4.875rem + 0.25rem padding; slim rows/placeholders are h-9.
    const scale =
      slimHeight !== undefined ? slimHeight / 36 : (headerScale ?? (cardHeight ?? 82) / 82);
    cardHeight ??= 82 * scale;
    slimHeight ??= 36 * scale;
    const labelHeight = (input.boundaryLabelHeight ?? 0) * scale;
    const projected: SidebarListItem[] = [];
    if (membership?.kind === "join") {
      // Joining a group changes no order: the lifted row, with any group it
      // leads, moves to the slot between the group's rows.
      const id = sidebarListItemId(active);
      const run = [...(leading.get(id) ?? []), active, ...(trailing.get(id) ?? [])];
      const rest = items.filter((item) => !run.includes(item));
      const overAt = rest.indexOf(over);
      if (overAt === -1) return [];
      const at = overAt + (overIndex > activeIndex ? 1 : 0);
      projected.push(...rest.slice(0, at), ...run, ...rest.slice(at));
    } else {
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
      ).filter(
        (key) => (key !== active.key || target.section === "settled") && !nestedKeys.has(key),
      );
      const visible = input.settledExpanded
        ? settledOrder.slice(0, input.settledVisibleCount ?? settledOrder.length)
        : [];
      const routeKey = input.routeThreadKey;
      if (routeKey && settledOrder.includes(routeKey) && !visible.includes(routeKey)) {
        visible.push(routeKey);
      }
      groups.settled = visible.map((key) => ({ kind: "thread", key, section: "settled" }));
      const emit = (item: SidebarListItem) => {
        const id = sidebarListItemId(item);
        projected.push(...(leading.get(id) ?? []), item, ...(trailing.get(id) ?? []));
      };
      const marker = (name: SidebarListMarker) => emit({ kind: "marker", marker: name });
      const section = (name: "active" | "settled") => {
        if (groups[name].length === 0) return marker(`${name}-placeholder`);
        // A group can sit right below the placeholder; it stays at the top.
        projected.push(...(trailing.get(sidebarMarkerId(`${name}-placeholder`)) ?? []));
        groups[name].forEach(emit);
      };
      marker("pinned-header");
      groups.pinned.forEach(emit);
      marker("pinned-divider");
      section("active");
      if (items.some((item) => item.kind === "marker" && item.marker === "working-header")) {
        marker("working-header");
        groups.working.forEach(emit);
      }
      if (
        groups.snoozed.length > 0 ||
        ((active.section !== "snoozed" || (input.snoozedThreadCount ?? 0) > 1) &&
          items.some((item) => item.kind === "marker" && item.marker === "snoozed-header"))
      ) {
        marker("snoozed-header");
        groups.snoozed.forEach(emit);
      }
      marker("settled-header");
      section("settled");
    }
    const heights = projected.map((item) => {
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      const fallback =
        item.kind === "thread" &&
        (item.section === "pinned" || item.section === "active" || item.section === "working")
          ? cardHeight
          : slimHeight;
      // The lifted row keeps its measured height while it stays a card or
      // stays a slim row.
      const moved =
        item.kind === "thread" &&
        item.key === active.key &&
        membership?.kind !== "join" &&
        isCardSection(active.section) !== isCardSection(target.section);
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
    // Consume the shelf's auto margin as drag labels and resized rows need
    // room, keeping the combined shelves at their measured bottom.
    let shelfSpace =
      shelfRect && beforeShelf && lastRect && shelfRect.top > beforeShelf.bottom + 1
        ? Math.max(
            0,
            lastRect.bottom - rects[0].top - heights.reduce((sum, height) => sum + height + 1, -1),
          )
        : 0;
    const result = items.map(() => hidden);
    let top = rects[0].top;
    for (const [projectedIndex, item] of projected.entries()) {
      if (isShelfHeader(item)) {
        top += shelfSpace;
        shelfSpace = 0;
      }
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
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
